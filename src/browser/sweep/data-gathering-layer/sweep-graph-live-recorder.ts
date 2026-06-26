import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { Disposable, DisposableCollection } from '@theia/core/lib/common';
import { PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import { SweepGraphService } from '../../../common/protocol';
import { readNesConfig } from '../../preferences/preferences-schema';
import { fileModeForLanguage } from '../../shared/file-mode';

/** Debounce live graph reindex, чтобы tree-sitter parse не запускался на каждый keystroke. */
const SWEEP_GRAPH_LIVE_DEBOUNCE_MS = 400;

/** Monaco adapter отправляет dirty source открытых code-моделей в Sweep CodeGraph backend. */
@injectable()
export class SweepGraphLiveRecorder implements FrontendApplicationContribution, Disposable {
    @inject(SweepGraphService) private readonly graph!: SweepGraphService;
    @inject(PreferenceService) private readonly preferences!: PreferenceService;

    private readonly toDispose = new DisposableCollection();
    private readonly modelDisposables = new Map<string, DisposableCollection>();
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

    /** Подключает live graph tracking ко всем текущим и будущим Monaco code-моделям. */
    onStart(): void {
        const models = monaco.editor.getModels();
        for (let i = 0; i < models.length; i++) {
            this.trackModel(models[i]);
        }
        this.toDispose.push(monaco.editor.onDidCreateModel(model => this.trackModel(model)));
    }

    /** Освобождает timers и Monaco subscriptions при остановке frontend contribution. */
    dispose(): void {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
        for (const disposable of this.modelDisposables.values()) {
            disposable.dispose();
        }
        this.modelDisposables.clear();
        this.toDispose.dispose();
    }

    /** Регистрирует code-модель для dirty-aware graph updates и disk rollback при закрытии. */
    private trackModel(model: monaco.editor.ITextModel): void {
        const uri = model.uri.toString();
        if (this.modelDisposables.has(uri) || fileModeForLanguage(model.getLanguageId()) !== 'code') {
            return;
        }
        const disposable = new DisposableCollection();
        disposable.push(model.onDidChangeContent(() => this.schedule(uri, model)));
        disposable.push(model.onWillDispose(() => this.onModelWillDispose(uri)));
        this.modelDisposables.set(uri, disposable);
    }

    /** Планирует live source reindex, если graph/fuzzy каналы включены для Sweep. */
    private schedule(uri: string, model: monaco.editor.ITextModel): void {
        this.cancel(uri);
        const timer = setTimeout(() => {
            this.timers.delete(uri);
            if (this.isEnabled()) {
                void this.graph.reindexFile(uri, model.getValue(), model.getLanguageId()).catch(() => undefined);
            }
        }, SWEEP_GRAPH_LIVE_DEBOUNCE_MS);
        this.timers.set(uri, timer);
    }

    /** Откатывает graph к disk-состоянию при закрытии dirty buffer без сохранения. */
    private onModelWillDispose(uri: string): void {
        this.cancel(uri);
        if (this.isEnabled()) {
            void this.graph.reindexFile(uri).catch(() => undefined);
        }
        this.modelDisposables.get(uri)?.dispose();
        this.modelDisposables.delete(uri);
    }

    /** Отменяет pending live update для URI при новом keystroke или закрытии модели. */
    private cancel(uri: string): void {
        const timer = this.timers.get(uri);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(uri);
        }
    }

    /** Проверяет актуальные NES preferences, чтобы выключение каналов сразу останавливало live traffic. */
    private isEnabled(): boolean {
        const config = readNesConfig(this.preferences);
        return (config.modelId === 'sweep-default' || config.modelId === 'sweep-small') && (config.graph.enabled || config.fuzzy.enabled);
    }
}
