import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { CancellationTokenSource, Disposable, DisposableCollection } from '@theia/core/lib/common';
import { PreferenceChange, PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import type { CompletionSchedulingMode } from '../../../common/model-types';
import type { NesResponse } from '../../../common/nes-types';
import { ZetaBackendService } from '../../../common/protocol';
import type { ZetaConfig } from '../../../common/zeta21/types';
import { ZetaLogger } from '../../../common/zeta21/logger';
import { NesViewZoneRenderer } from '../../nes-render/nes-view-zone-renderer';
import { readCompletionSchedulingMode, readZetaConfig } from '../../preferences/preferences-schema';
import { ZetaContextCollector } from '../data-gathering-layer/zeta-context-collector';
import { ZetaEditHistoryRecorder } from '../data-gathering-layer/zeta-edit-history-recorder';
import { ZetaRequestBuilder } from '../data-formatting-layer/zeta-request-builder';

// Логгер trigger-layer нужен для сквозной диагностики zeta21 trigger-cycle на фронтенде.
const LOG = new ZetaLogger('browser:trigger');

// Снимок состояния редактора на момент trigger; null означает что editor потерял focus или модель.
interface ZetaTriggerState {
    editor: monaco.editor.ICodeEditor;
    model: monaco.editor.ITextModel | null;
    position: monaco.Position | null;
}

/** Zeta trigger controller слушает редакторы, собирает контекст и вызывает отдельный zeta21 backend path. */
@injectable()
export class ZetaController implements FrontendApplicationContribution, Disposable {
    @inject(ZetaBackendService) private readonly zeta!: ZetaBackendService;
    @inject(PreferenceService) private readonly preferences!: PreferenceService;
    @inject(ZetaEditHistoryRecorder) private readonly history!: ZetaEditHistoryRecorder;
    @inject(NesViewZoneRenderer) private readonly renderer!: NesViewZoneRenderer;
    @inject(ZetaContextCollector) private readonly collector!: ZetaContextCollector;

    private readonly toDispose = new DisposableCollection();
    private readonly editorDisposables = new WeakMap<monaco.editor.ICodeEditor, DisposableCollection>();
    private readonly requestBuilder = new ZetaRequestBuilder();
    private config!: ZetaConfig;
    // Флаг глобального включения NES из настроек.
    private enabled = true;
    // Политика планирования FIM/NES; заменяет старый coordinationMode.
    private schedulingMode: CompletionSchedulingMode = 'parallel';
    private timer: ReturnType<typeof setTimeout> | undefined;
    // Timestamp последнего изменения контента; используется для idle-nes гейтинга.
    private lastChangeAt = 0;
    private inFlight: CancellationTokenSource | undefined;

    /** Поднимает zeta21 config, подключает tracking редакторов и подписывается на preference changes для живой переконфигурации. */
    async onStart(): Promise<void> {
        await this.pushConfig();
        const editors = monaco.editor.getEditors();
        for (let i = 0; i < editors.length; i++) {
            this.trackEditor(editors[i]);
        }
        this.toDispose.push(monaco.editor.onDidCreateEditor(editor => this.trackEditor(editor)));
        this.toDispose.push(this.preferences.onPreferenceChanged((event: PreferenceChange) => {
            if (
                event.preferenceName.startsWith('smart-completions.nes') ||
                event.preferenceName === 'smart-completions.completionSchedulingMode' ||
                event.preferenceName === 'smart-completions.coordinationMode'
            ) {
                void this.pushConfig();
            }
        }));
        LOG.info('Zeta controller started', { editors: editors.length });
    }

    /** Отменяет текущий in-flight запрос, сбрасывает debounce timer и освобождает все подписки. */
    dispose(): void {
        this.inFlight?.cancel();
        this.inFlight?.dispose();
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.toDispose.dispose();
        LOG.info('Zeta controller disposed');
    }

    private trackEditor(editor: monaco.editor.ICodeEditor): void {
        if (this.editorDisposables.has(editor)) {
            return;
        }
        const disposable = new DisposableCollection();
        disposable.push(editor.onDidChangeModelContent(() => {
            this.lastChangeAt = Date.now();
            this.renderer.dismiss();
            this.schedule(editor);
        }));
        disposable.push(editor.onDidChangeCursorPosition(() => this.schedule(editor)));
        disposable.push(monaco.editor.onDidChangeMarkers(resources => {
            const model = editor.getModel();
            if (!model) {
                return;
            }
            const uri = model.uri.toString();
            for (let i = 0; i < resources.length; i++) {
                if (resources[i].toString() === uri) {
                    this.schedule(editor);
                    break;
                }
            }
        }));
        disposable.push(editor.onDidDispose(() => disposable.dispose()));
        this.editorDisposables.set(editor, disposable);
    }

    /** Откладывает вызов trigger на debounceMs, сбрасывая предыдущий таймер. */
    private schedule(editor: monaco.editor.ICodeEditor): void {
        if (!this.canSchedule()) {
            return;
        }
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => void this.trigger(editor), this.config.debounceMs);
    }

    /**
     * Полный цикл одного Zeta-предсказания: снимок → сбор контекста →
     * запрос бекенда → рендер. На каждом шаге проверяет staleness.
     */
    private async trigger(editor: monaco.editor.ICodeEditor): Promise<void> {
        const state = this.readTriggerState(editor);
        if (!this.canTrigger(state)) return;
        if (!this.canRunBySchedulingPolicy()) return;

        const diagnostics = collectDiagnostics(state.model);
        const snapshot = await this.requestBuilder.snapshot(state.model, state.position, this.history, diagnostics);
        if (!snapshot) return;

        const source = this.startRequest();
        const version = state.model.getVersionId();

        LOG.info('Zeta trigger started', { uri: state.model.uri.toString(), version, modelId: 'zeta-2.1' });
        try {
            const collected = await this.collectZetaContext(state, snapshot);
            if (this.isStale(state.model, version, source)) return;

            const request = this.requestBuilder.request(state.model, snapshot, collected);
            const response = await this.zeta.predict(request, source.token);
            if (this.isStale(state.model, version, source)) return;

            this.renderIfUseful(state.editor, response);
        } catch (error) {
            this.handleTriggerError(error);
        } finally {
            this.finishRequest(source);
        }
    }

    /** Обновляет конфиг из preferences, останавливает если модель неактивна, отправляет config на бекенд. */
    private async pushConfig(): Promise<void> {
        this.readControllerConfig();
        this.stopIfInactive();
        await this.pushBackendConfigIfActive();
    }

    private readControllerConfig(): void {
        this.config = readZetaConfig(this.preferences);
        this.enabled = this.preferences.get<boolean>('smart-completions.nes.enabled', true);
        this.schedulingMode = readCompletionSchedulingMode(this.preferences);
    }

    /** Отменяет in-flight запрос и скрывает подсказку если активная модель сменилась. */
    private stopIfInactive(): void {
        if (this.isActiveModel()) return;
        this.inFlight?.cancel();
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.renderer.dismiss();
    }

    /** Отправляет текущий ZetaConfig на бекенд только если zeta-2.1 является активной моделью. */
    private async pushBackendConfigIfActive(): Promise<void> {
        if (!this.isActiveModel()) return;
        await this.zeta.configure(this.config);
    }

    private canSchedule(): boolean {
        return this.enabled && this.isActiveModel();
    }

    private readTriggerState(editor: monaco.editor.ICodeEditor): ZetaTriggerState {
        return {
            editor,
            model: editor.getModel(),
            position: editor.getPosition(),
        };
    }

    private canTrigger(state: ZetaTriggerState): state is ZetaTriggerState & { model: monaco.editor.ITextModel; position: monaco.Position } {
        return Boolean(state.model && state.position && this.enabled && this.isActiveModel());
    }

    /** Разрешает trigger в соответствии с политикой планирования; idle-nes требует истечения debounce. */
    private canRunBySchedulingPolicy(): boolean {
        if (this.schedulingMode !== 'idle-nes') return true;
        return Date.now() - this.lastChangeAt >= this.config.debounceMs;
    }

    /** Отменяет предыдущий запрос и создаёт новый CancellationTokenSource для следующего цикла. */
    private startRequest(): CancellationTokenSource {
        this.inFlight?.cancel();
        this.inFlight?.dispose();
        const source = new CancellationTokenSource();
        this.inFlight = source;
        return source;
    }

    private async collectZetaContext(
        state: ZetaTriggerState & { model: monaco.editor.ITextModel; position: monaco.Position },
        snapshot: Awaited<ReturnType<ZetaRequestBuilder['snapshot']>> & {},
    ) {
        return this.collector.collect({
            model: state.model,
            position: state.position,
            languageId: state.model.getLanguageId(),
            windowText: snapshot.windowText,
            cursorOffset: snapshot.cursorOffset,
            recentEdits: snapshot.recentEdits,
            diagnostics: snapshot.diagnostics,
            relatedTopN: this.config.relatedTopN,
            queryMaxChars: this.config.queryMaxChars,
        });
    }

    /** Проверяет staleness по версии модели или отмене запроса; при true trigger прерывается без рендера. */
    private isStale(
        model: monaco.editor.ITextModel,
        version: number,
        source: CancellationTokenSource,
    ): boolean {
        return source.token.isCancellationRequested || model.getVersionId() !== version;
    }

    private renderIfUseful(editor: monaco.editor.ICodeEditor, response: Awaited<ReturnType<ZetaBackendService['predict']>>): void {
        if (response.edits.length === 0) return;
        this.renderer.show(editor, toRendererResponse(response));
        LOG.info('Zeta suggestion rendered', { edits: response.edits.length, modelId: response.modelId });
    }

    private handleTriggerError(error: unknown): void {
        // release build strips logs; trigger failures remain fail-open.
        LOG.warn('Zeta trigger failed', { error: error instanceof Error ? error.message : String(error) });
    }

    private finishRequest(source: CancellationTokenSource): void {
        if (this.inFlight === source) {
            this.inFlight = undefined;
        }
        source.dispose();
    }

    private isActiveModel(): boolean {
        return this.preferences.get<string>('smart-completions.nes.modelId', 'sweep-default') === 'zeta-2.1';
    }
}

function toRendererResponse(response: Awaited<ReturnType<ZetaBackendService['predict']>>): NesResponse {
    return {
        edits: response.edits,
        primaryRange: response.primaryRange ?? undefined,
        jumpTo: response.jumpTo ?? undefined,
        modelId: response.modelId,
    };
}

function collectDiagnostics(model: monaco.editor.ITextModel): import('../../../common/editor-dto').DiagnosticDTO[] {
    const markers = monaco.editor.getModelMarkers({ resource: model.uri, take: 20 });
    const diagnostics = new Array<import('../../../common/editor-dto').DiagnosticDTO>(markers.length);
    for (let i = 0; i < markers.length; i++) {
        const marker = markers[i];
        diagnostics[i] = {
            range: {
                start: { line: marker.startLineNumber - 1, character: marker.startColumn - 1 },
                end: { line: marker.endLineNumber - 1, character: marker.endColumn - 1 },
            },
            severity: marker.severity === monaco.MarkerSeverity.Error
                ? 'error' as const
                : marker.severity === monaco.MarkerSeverity.Warning
                    ? 'warning' as const
                    : marker.severity === monaco.MarkerSeverity.Info
                        ? 'info' as const
                        : 'hint' as const,
            message: marker.message,
            code: marker.code ? String(marker.code) : undefined,
        };
    }
    return diagnostics;
}
