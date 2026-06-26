import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { Disposable, DisposableCollection } from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import type { RecentEdit } from '../../../common/edit-history-types';
import { EditHistoryStore } from '../../../common/sweep/edit-history-store';
import { ZetaLogger } from '../../../common/zeta21/logger';

// Логгер адаптера нужен для диагностики жизненного цикла zeta21 Monaco-model tracking.
const LOG = new ZetaLogger('browser:data-gathering:edit-history');

/** Тонкий Monaco-адаптер над EditHistoryStore для zeta21, который только проводит editor events в monaco-free ядро. */
@injectable()
export class ZetaEditHistoryRecorder implements FrontendApplicationContribution, Disposable {
    private readonly toDispose = new DisposableCollection();
    private readonly modelDisposables = new Map<string, DisposableCollection>();
    private readonly store = new EditHistoryStore();

    /** Подключает трекинг ко всем уже открытым моделям и подписывается на создание новых, чтобы история правок копилась с первого момента работы. */
    onStart(): void {
        const models = monaco.editor.getModels();
        for (let i = 0; i < models.length; i++) {
            this.trackModel(models[i]);
        }
        this.toDispose.push(monaco.editor.onDidCreateModel(model => this.trackModel(model)));
        LOG.info('Zeta edit history recorder started', { models: models.length });
    }

    /** Делегирует чтение свежих диффов ядру; история глобальна и фильтрация по uri не требуется. */
    getRecentEdits(_uri?: string, limit = 8): RecentEdit[] {
        return this.store.getRecentEdits(limit);
    }

    /** Освобождает Monaco-подписки и сбрасывает ядро, чтобы рекордер не удерживал модели и таймеры после остановки. */
    dispose(): void {
        this.toDispose.dispose();
        for (const disposable of this.modelDisposables.values()) {
            disposable.dispose();
        }
        this.modelDisposables.clear();
        this.store.dispose();
        LOG.info('Zeta edit history recorder disposed');
    }

    private trackModel(model: monaco.editor.ITextModel): void {
        const uri = model.uri.toString();
        if (this.modelDisposables.has(uri)) {
            return;
        }
        this.store.track({ uri, getValue: () => model.getValue() });
        const disposable = new DisposableCollection();
        disposable.push(model.onDidChangeContent(() => this.store.scheduleRecord(uri)));
        disposable.push(model.onWillDispose(() => {
            this.store.untrack(uri);
            this.modelDisposables.get(uri)?.dispose();
            this.modelDisposables.delete(uri);
        }));
        this.modelDisposables.set(uri, disposable);
    }
}
