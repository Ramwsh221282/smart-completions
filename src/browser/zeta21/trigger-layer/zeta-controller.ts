import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { CancellationTokenSource, Disposable, DisposableCollection } from '@theia/core/lib/common';
import { PreferenceChange, PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import type { CoordinationMode } from '../../../common/model-types';
import type { NesResponse } from '../../../common/nes-types';
import { ZetaBackendService } from '../../../common/protocol';
import type { ZetaConfig } from '../../../common/zeta21/types';
import { ZetaLogger } from '../../../common/zeta21/logger';
import { NesViewZoneRenderer } from '../../nes-render/nes-view-zone-renderer';
import { readZetaConfig } from '../../preferences/preferences-schema';
import { ZetaContextCollector } from '../data-gathering-layer/zeta-context-collector';
import { ZetaEditHistoryRecorder } from '../data-gathering-layer/zeta-edit-history-recorder';
import { ZetaRequestBuilder } from '../data-formatting-layer/zeta-request-builder';

// Логгер trigger-layer нужен для сквозной диагностики zeta21 trigger-cycle на фронтенде.
const LOG = new ZetaLogger('browser:trigger');

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
    private enabled = true;
    private coordinationMode: CoordinationMode = 'exclusive-priority';
    private timer: ReturnType<typeof setTimeout> | undefined;
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
            if (event.preferenceName.startsWith('smart-completions.nes') || event.preferenceName === 'smart-completions.coordinationMode') {
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

    private schedule(editor: monaco.editor.ICodeEditor): void {
        if (!this.enabled || this.coordinationMode === 'fim-only' || !this.isActiveModel()) {
            return;
        }
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => void this.trigger(editor), this.config.debounceMs);
    }

    private async trigger(editor: monaco.editor.ICodeEditor): Promise<void> {
        const model = editor.getModel();
        const position = editor.getPosition();
        if (!model || !position || !this.enabled || this.coordinationMode === 'fim-only' || !this.isActiveModel()) {
            return;
        }
        if (this.coordinationMode === 'exclusive-priority' && Date.now() - this.lastChangeAt < this.config.debounceMs) {
            return;
        }
        const diagnostics = collectDiagnostics(model);
        const snapshot = await this.requestBuilder.snapshot(model, position, this.history, diagnostics);
        if (!snapshot) {
            return;
        }
        this.inFlight?.cancel();
        this.inFlight?.dispose();
        const source = new CancellationTokenSource();
        this.inFlight = source;
        const version = model.getVersionId();
        LOG.info('Zeta trigger started', { uri: model.uri.toString(), version, modelId: 'zeta-2.1' });
        try {
            const collected = await this.collector.collect({
                model,
                position,
                languageId: model.getLanguageId(),
                windowText: snapshot.windowText,
                cursorOffset: snapshot.cursorOffset,
                recentEdits: snapshot.recentEdits,
                diagnostics: snapshot.diagnostics,
                relatedTopN: this.config.relatedTopN,
                queryMaxChars: this.config.queryMaxChars,
            });
            if (source.token.isCancellationRequested || model.getVersionId() !== version) {
                return;
            }
            const request = this.requestBuilder.request(model, snapshot, collected);
            const response = await this.zeta.predict(request, source.token);
            if (source.token.isCancellationRequested || model.getVersionId() !== version) {
                return;
            }
            if (response.edits.length === 0) {
                return;
            }
            this.renderer.show(editor, toRendererResponse(response));
            LOG.info('Zeta suggestion rendered', { edits: response.edits.length, modelId: response.modelId });
        } catch (error) {
            LOG.warn('Zeta trigger failed', { error: error instanceof Error ? error.message : String(error) });
        } finally {
            if (this.inFlight === source) {
                this.inFlight = undefined;
            }
            source.dispose();
        }
    }

    private async pushConfig(): Promise<void> {
        this.config = readZetaConfig(this.preferences);
        this.enabled = this.preferences.get<boolean>('smart-completions.nes.enabled', true);
        this.coordinationMode = this.preferences.get<CoordinationMode>('smart-completions.coordinationMode', 'exclusive-priority');
        if (!this.isActiveModel()) {
            this.inFlight?.cancel();
            if (this.timer) {
                clearTimeout(this.timer);
                this.timer = undefined;
            }
            this.renderer.dismiss();
        }
        try {
            await this.zeta.configure(this.config);
            LOG.info('Zeta controller pushed config', { enabled: this.enabled, coordinationMode: this.coordinationMode, modelId: 'zeta-2.1' });
        } catch (error) {
            LOG.warn('Zeta controller failed to push config', { error: error instanceof Error ? error.message : String(error) });
        }
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
    if (process.env.NODE_ENV === 'development') {
        LOG.debug('Zeta diagnostics collected from Monaco', { uri: model.uri.toString(), diagnostics: diagnostics.length });
    }
    return diagnostics;
}
