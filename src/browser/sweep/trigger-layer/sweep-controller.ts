import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { CancellationTokenSource, Disposable, DisposableCollection } from '@theia/core/lib/common';
import { PreferenceChange, PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import { CoreBackendService } from '../../../common/core/core-protocol';
import { buildCoreCompletionRequest } from '../../../common/core/core-request-mapping';
import type { CompletionSchedulingMode, CoreNesRouting } from '../../../common/model-types';
import type { NesConfig, NesResponse } from '../../../common/nes-types';
import { NesBackendService } from '../../../common/protocol';
import { SweepLogger } from '../../../common/sweep/logger';
import { NesAcceptHookContext, NesViewZoneRenderer } from '../../nes-render/nes-view-zone-renderer';
import { readCompletionSchedulingMode, readCoreNesRouting, readNesConfig } from '../../preferences/preferences-schema';
import { fileModeForLanguage } from '../../shared/file-mode';
import { SweepContextCollector } from '../data-gathering-layer/sweep-context-collector';
import { SweepEditHistoryRecorder } from '../data-gathering-layer/sweep-edit-history-recorder';
import { buildSweepCoreContext } from '../data-formatting-layer/sweep-core-envelope';
import { SweepRequestBuilder } from '../data-formatting-layer/sweep-request-builder';
import { resolveSweepPrediction } from './sweep-prediction-router';
import { DiagnosticsDeltaSnapshot, DiagnosticsDeltaVerifier } from '../quality/diagnostics-delta-verifier';

// Логгер триггерного слоя Sweep на фронтенде.
const LOG = new SweepLogger('browser:trigger');

// Снимок состояния редактора на момент trigger; null означает что editor потерял focus или модель.
interface SweepTriggerState {
    editor: monaco.editor.ICodeEditor;
    model: monaco.editor.ITextModel | null;
    position: monaco.Position | null;
}

/** Триггерный контроллер Sweep: слушает редакторы, собирает контекст, вызывает бекенд и передаёт правки рендереру. */
@injectable()
export class SweepController implements FrontendApplicationContribution, Disposable {
    @inject(CoreBackendService) private readonly core!: CoreBackendService;
    // RPC-фасад NES бекенда для отправки predict/configure запросов.
    @inject(NesBackendService) private readonly nes!: NesBackendService;
    // Сервис чтения и подписки на preference-настройки Theia.
    @inject(PreferenceService) private readonly preferences!: PreferenceService;
    // Sweep-owned хранилище истории правок; обязательный источник контекста.
    @inject(SweepEditHistoryRecorder) private readonly history!: SweepEditHistoryRecorder;
    // Общий рендерер NES View Zone для показа, принятия и отклонения подсказок.
    @inject(NesViewZoneRenderer) private readonly renderer!: NesViewZoneRenderer;
    // Сборщик контекста из Theia-источников (LSP, SCM, output и др.).
    @inject(SweepContextCollector) private readonly collector!: SweepContextCollector;
    @inject(DiagnosticsDeltaVerifier) private readonly diagnosticsVerifier!: DiagnosticsDeltaVerifier;

    // Корневой DisposableCollection для подписок уровня приложения.
    private readonly toDispose = new DisposableCollection();
    // Подписки на события конкретных редакторов; WeakMap чтобы не удерживать редакторы в памяти.
    private readonly editorDisposables = new WeakMap<monaco.editor.ICodeEditor, DisposableCollection>();
    // Строитель снимка и NES-запроса из состояния Monaco-модели.
    private readonly requestBuilder = new SweepRequestBuilder();
    // Текущая конфигурация NES, синхронизированная с preferences.
    private config!: NesConfig;
    // Флаг глобального включения NES из настроек.
    private enabled = true;
    // Флаг experimental Rust-core path; при false всегда идём в TS backend.
    private coreEnabled = false;
    // Маршрутизация NES при включённом core; core-only отключает TS NES fallback для sweep-моделей.
    private coreNesRouting: CoreNesRouting = 'fallback';
    // Политика планирования FIM/NES; заменяет старый coordinationMode.
    private schedulingMode: CompletionSchedulingMode = 'parallel';
    // Таймер debounce для откладывания trigger после последнего события редактора.
    private timer: ReturnType<typeof setTimeout> | undefined;
    // Timestamp последнего изменения контента; используется для idle-nes гейтинга.
    private lastChangeAt = 0;
    // Токен отмены текущего in-flight Sweep запроса.
    private inFlight: CancellationTokenSource | undefined;
    // Монотонный numeric id для корреляции core completion запросов.
    private requestCounter = 0;

    /**
     * Точка входа при старте приложения: отправляет конфиг на бекенд,
     * подключает трекинг всех существующих и будущих редакторов,
     * и подписывается на изменения preference для переконфигурации.
     */
    async onStart(): Promise<void> {
        await this.pushConfig();
        this.renderer.setAcceptHook({
            beforeAccept: context => this.beforeNesAccept(context),
            afterAccept: (context, state, acceptedVersion) => this.afterNesAccept(context, state, acceptedVersion),
        });
        for (const editor of monaco.editor.getEditors()) {
            this.trackEditor(editor);
        }
        this.toDispose.push(monaco.editor.onDidCreateEditor(editor => this.trackEditor(editor)));
        this.toDispose.push(this.preferences.onPreferenceChanged((event: PreferenceChange) => {
            if (
                event.preferenceName.startsWith('smart-completions.nes') ||
                event.preferenceName.startsWith('smart-completions.core') ||
                event.preferenceName === 'smart-completions.completionSchedulingMode' ||
                event.preferenceName === 'smart-completions.coordinationMode'
            ) {
                void this.pushConfig();
            }
        }));
        LOG.info('Sweep controller started', { editors: monaco.editor.getEditors().length });
    }

    /** Принимает текущую видимую NES-подсказку через рендерер. */
    accept(): void {
        this.renderer.accept();
    }

    /** Скрывает текущую видимую NES-подсказку через рендерер. */
    dismiss(): void {
        this.renderer.dismiss();
    }

    /** Перепрыгивает к месту удалённой правки; при повторном вызове в том же месте — принимает. */
    jumpOrAccept(): void {
        this.renderer.jumpOrAccept();
    }

    /**
     * Отменяет текущий in-flight запрос, сбрасывает debounce-таймер,
     * скрывает подсказку и освобождает все подписки.
     */
    dispose(): void {
        this.inFlight?.cancel();
        this.inFlight?.dispose();
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.renderer.setAcceptHook(undefined);
        this.renderer.dismiss();
        this.toDispose.dispose();
        LOG.info('Sweep controller disposed');
    }

    /** Снимает diagnostics snapshot перед единственным renderer.accept chokepoint. */
    private beforeNesAccept(context: NesAcceptHookContext): DiagnosticsDeltaSnapshot | undefined {
        const gate = this.config.diagnosticsGate;
        if (!gate.enabled || fileModeForLanguage(context.model.getLanguageId()) !== 'code' || context.edits.length !== 1) {
            return undefined;
        }
        return this.diagnosticsVerifier.snapshotBefore(context.model, context.edits[0]);
    }

    /** Запускает post-apply diagnostics verifier после реального executeEdits без блокировки UI. */
    private afterNesAccept(context: NesAcceptHookContext, state: unknown, acceptedVersion: number): void {
        if (!isDiagnosticsDeltaSnapshot(state) || !this.config.diagnosticsGate.enabled) {
            return;
        }
        void this.diagnosticsVerifier.verify(context.editor, state, acceptedVersion, this.config.diagnosticsGate);
    }

    /**
     * Подключает к редактору слушатели изменений контента и позиции курсора.
     * При изменении контента сбрасывает текущую подсказку и запускает debounce.
     */
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
     * Полный цикл одного Sweep-предсказания: снимок → сбор контекста →
     * запрос бекенда → рендер. На каждом шаге проверяет staleness.
     */
    private async trigger(editor: monaco.editor.ICodeEditor): Promise<void> {
        const state = this.readTriggerState(editor);
        if (!this.canTrigger(state)) return;
        if (!this.canRunBySchedulingPolicy()) return;

        const snapshot = this.createSnapshot(state);
        if (!snapshot) return;

        const source = this.startRequest();
        const version = state.model.getVersionId();

        LOG.info('Sweep trigger started', { uri: state.model.uri.toString(), version, modelId: this.config.modelId });
        try {
            const collected = await this.collectContext(state, snapshot, source);
            if (this.isStale(state.model, version, source)) return;

            const response = await resolveSweepPrediction(
                { coreEnabled: this.coreEnabled, routing: this.coreNesRouting },
                () => this.tryCorePrediction(state.model, state.position, snapshot, collected, version, source),
                () => this.predictViaTsBackend(state.model, snapshot, collected, source),
            );
            if (!response || this.isStale(state.model, version, source)) return;

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
        this.config = readNesConfig(this.preferences);
        this.enabled = this.preferences.get<boolean>('smart-completions.nes.enabled', true);
        this.coreEnabled = this.preferences.get<boolean>('smart-completions.core.enabled', false);
        this.coreNesRouting = readCoreNesRouting(this.preferences);
        this.schedulingMode = readCompletionSchedulingMode(this.preferences);
    }

    /** Отменяет in-flight запрос и скрывает подсказку если активная модель сменилась на non-Sweep. */
    private stopIfInactive(): void {
        if (this.isActiveModel()) return;
        this.inFlight?.cancel();
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.renderer.dismiss();
    }

    /** Отправляет текущий NesConfig на бекенд только если Sweep является активной моделью. */
    private async pushBackendConfigIfActive(): Promise<void> {
        if (!this.isActiveModel()) return;
        await this.nes.configure(this.config);
    }

    private canSchedule(): boolean {
        return this.enabled && this.isActiveModel();
    }

    private readTriggerState(editor: monaco.editor.ICodeEditor): SweepTriggerState {
        return {
            editor,
            model: editor.getModel(),
            position: editor.getPosition(),
        };
    }

    private canTrigger(state: SweepTriggerState): state is SweepTriggerState & { model: monaco.editor.ITextModel; position: monaco.Position } {
        return Boolean(state.model && state.position && this.enabled && this.isActiveModel());
    }

    /** Разрешает trigger в соответствии с политикой планирования; idle-nes требует истечения debounce. */
    private canRunBySchedulingPolicy(): boolean {
        if (this.schedulingMode !== 'idle-nes') return true;
        return Date.now() - this.lastChangeAt >= this.config.debounceMs;
    }

    private createSnapshot(state: SweepTriggerState & { model: monaco.editor.ITextModel; position: monaco.Position }) {
        return this.requestBuilder.snapshot(state.model, state.position, this.history, this.config.profile);
    }

    /** Отменяет предыдущий запрос и создаёт новый CancellationTokenSource для следующего цикла. */
    private startRequest(): CancellationTokenSource {
        this.inFlight?.cancel();
        this.inFlight?.dispose();
        const source = new CancellationTokenSource();
        this.inFlight = source;
        return source;
    }

    private async collectContext(
        state: SweepTriggerState & { model: monaco.editor.ITextModel; position: monaco.Position },
        snapshot: ReturnType<SweepRequestBuilder['snapshot']> & {},
        _source: CancellationTokenSource,
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

    private async tryCorePrediction(
        model: monaco.editor.ITextModel,
        position: monaco.Position,
        snapshot: NonNullable<ReturnType<SweepRequestBuilder['snapshot']>>,
        collected: Awaited<ReturnType<SweepContextCollector['collect']>>,
        version: number,
        source: CancellationTokenSource,
    ): Promise<NesResponse | undefined> {
        try {
            const coreContext = buildSweepCoreContext(snapshot, collected, this.config.queryMaxChars);
            const result = await this.core.requestCompletion(buildCoreCompletionRequest({
                requestId: this.nextRequestId(),
                mode: 'nes',
                modelId: this.config.modelId,
                uri: model.uri.toString(),
                version,
                languageId: model.getLanguageId(),
                fileMode: fileModeForLanguage(model.getLanguageId()),
                cursor: {
                    lineNumber: position.lineNumber,
                    column: position.column,
                    offset: model.getOffsetAt(position),
                },
                configVersion: 0,
                context: coreContext,
            }));
            if (!result.accepted || !result.edit || source.token.isCancellationRequested || model.getVersionId() !== version) {
                return undefined;
            }
            return {
                edits: [{ range: result.edit.range, newText: result.edit.newText }],
                primaryRange: result.edit.range,
                jumpTo: result.edit.jumpTo,
                modelId: this.config.modelId,
            };
        } catch {
            return undefined;
        }
    }

    private predictViaTsBackend(
        model: monaco.editor.ITextModel,
        snapshot: NonNullable<ReturnType<SweepRequestBuilder['snapshot']>>,
        collected: Awaited<ReturnType<SweepContextCollector['collect']>>,
        source: CancellationTokenSource,
    ): Promise<NesResponse> {
        const request = this.requestBuilder.request(model, snapshot, collected);
        return this.nes.predict(request, source.token);
    }

    /** Проверяет staleness по версии модели или отмене запроса; при true trigger прерывается без рендера. */
    private isStale(
        model: monaco.editor.ITextModel,
        version: number,
        source: CancellationTokenSource,
    ): boolean {
        return source.token.isCancellationRequested || model.getVersionId() !== version;
    }

    private renderIfUseful(editor: monaco.editor.ICodeEditor, response: NesResponse): void {
        if (response.edits.length === 0) return;
        this.renderer.show(editor, response);
        LOG.info('Sweep suggestion rendered', { edits: response.edits.length, modelId: response.modelId });
    }

    private nextRequestId(): number {
        this.requestCounter += 1;
        return this.requestCounter;
    }

    private handleTriggerError(error: unknown): void {
        // release build strips logs; trigger failures remain fail-open.
        LOG.warn('Sweep trigger failed', { error: error instanceof Error ? error.message : String(error) });
    }

    private finishRequest(source: CancellationTokenSource): void {
        if (this.inFlight === source) {
            this.inFlight = undefined;
        }
        source.dispose();
    }

    private isActiveModel(): boolean {
        return this.config.modelId === 'sweep-default' || this.config.modelId === 'sweep-small';
    }
}

/** Type guard для hook state, чтобы renderer оставался независимым от Sweep verifier. */
function isDiagnosticsDeltaSnapshot(value: unknown): value is DiagnosticsDeltaSnapshot {
    return typeof value === 'object'
        && value !== null
        && typeof (value as { uri?: unknown }).uri === 'string'
        && typeof (value as { beforeErrors?: unknown }).beforeErrors === 'number'
        && typeof (value as { beforeVersion?: unknown }).beforeVersion === 'number'
        && typeof (value as { inverseEdit?: unknown }).inverseEdit === 'object'
        && (value as { inverseEdit?: unknown }).inverseEdit !== null;
}
