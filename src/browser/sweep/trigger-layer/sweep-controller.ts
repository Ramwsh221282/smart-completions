import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { CancellationTokenSource, Disposable, DisposableCollection } from '@theia/core/lib/common';
import { PreferenceChange, PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import { CoordinationMode } from '../../../common/model-types';
import { NesConfig } from '../../../common/nes-types';
import { NesBackendService } from '../../../common/protocol';
import { SweepLogger } from '../../../common/sweep/logger';
import { NesAcceptHookContext, NesViewZoneRenderer } from '../../nes-render/nes-view-zone-renderer';
import { readNesConfig } from '../../preferences/preferences-schema';
import { fileModeForLanguage } from '../../shared/file-mode';
import { SweepContextCollector } from '../data-gathering-layer/sweep-context-collector';
import { SweepEditHistoryRecorder } from '../data-gathering-layer/sweep-edit-history-recorder';
import { SweepRequestBuilder } from '../data-formatting-layer/sweep-request-builder';
import { DiagnosticsDeltaSnapshot, DiagnosticsDeltaVerifier } from '../quality/diagnostics-delta-verifier';

// Логгер триггерного слоя Sweep на фронтенде.
const LOG = new SweepLogger('browser:trigger');

/** Триггерный контроллер Sweep: слушает редакторы, собирает контекст, вызывает бекенд и передаёт правки рендереру. */
@injectable()
export class SweepController implements FrontendApplicationContribution, Disposable {
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
    // Режим координации FIM и NES (exclusive-priority / fim-only / nes-only).
    private coordinationMode: CoordinationMode = 'exclusive-priority';
    // Таймер debounce для откладывания trigger после последнего события редактора.
    private timer: ReturnType<typeof setTimeout> | undefined;
    // Timestamp последнего изменения контента; используется для exclusive-priority гейтинга.
    private lastChangeAt = 0;
    // Токен отмены текущего in-flight Sweep запроса.
    private inFlight: CancellationTokenSource | undefined;

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
            if (event.preferenceName.startsWith('smart-completions.nes') || event.preferenceName === 'smart-completions.coordinationMode') {
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
        if (process.env.NODE_ENV === 'development') {
            LOG.debug('Sweep editor tracking enabled');
        }
    }

    /**
     * Откладывает вызов trigger на debounceMs, сбрасывая предыдущий таймер.
     * Пропускает вызов если NES отключён или активен режим fim-only.
     */
    private schedule(editor: monaco.editor.ICodeEditor): void {
        if (!this.enabled || this.coordinationMode === 'fim-only') {
            if (process.env.NODE_ENV === 'development') {
                LOG.debug('Sweep schedule skipped', { enabled: this.enabled, coordinationMode: this.coordinationMode });
            }
            return;
        }
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => void this.trigger(editor), this.config.debounceMs);
        if (process.env.NODE_ENV === 'development') {
            LOG.debug('Sweep trigger scheduled', { debounceMs: this.config.debounceMs });
        }
    }

    /**
     * Полный цикл одного Sweep-предсказания: снимок состояния → сбор контекста →
     * построение запроса → вызов бекенда → рендер подсказки. На каждом шаге
     * проверяет отмену и версию модели; при несовпадении — прерывает без рендера.
     */
    private async trigger(editor: monaco.editor.ICodeEditor): Promise<void> {
        const model = editor.getModel();
        const position = editor.getPosition();
        if (!model || !position || !this.enabled || this.coordinationMode === 'fim-only') {
            if (process.env.NODE_ENV === 'development') {
                LOG.debug('Sweep trigger skipped before snapshot', { hasModel: Boolean(model), hasPosition: Boolean(position), enabled: this.enabled, coordinationMode: this.coordinationMode });
            }
            return;
        }
        if (this.coordinationMode === 'exclusive-priority' && Date.now() - this.lastChangeAt < this.config.debounceMs) {
            if (process.env.NODE_ENV === 'development') {
                LOG.debug('Sweep trigger skipped by exclusive-priority timing', { sinceLastChangeMs: Date.now() - this.lastChangeAt, debounceMs: this.config.debounceMs });
            }
            return;
        }

        const snapshot = this.requestBuilder.snapshot(model, position, this.history, this.config.profile);
        if (!snapshot) {
            return;
        }

        this.inFlight?.cancel();
        this.inFlight?.dispose();
        const source = new CancellationTokenSource();
        this.inFlight = source;
        const version = model.getVersionId();
        LOG.info('Sweep trigger started', { uri: model.uri.toString(), version, modelId: this.config.modelId });
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
                LOG.info('Sweep trigger cancelled after context collection', { cancelled: source.token.isCancellationRequested, versionChanged: model.getVersionId() !== version });
                return;
            }
            const request = this.requestBuilder.request(model, snapshot, collected);
            const response = await this.nes.predict(request, source.token);
            if (source.token.isCancellationRequested || model.getVersionId() !== version) {
                LOG.info('Sweep trigger produced stale edit', { cancelled: source.token.isCancellationRequested, versionChanged: model.getVersionId() !== version, edits: response.edits.length });
                return;
            }
            if (response.edits.length === 0) {
                LOG.info('Sweep trigger produced no visible edit', { edits: response.edits.length });
                return;
            }
            this.renderer.show(editor, response);
            LOG.info('Sweep suggestion rendered', { edits: response.edits.length, modelId: response.modelId });
        } catch (error) {
            LOG.warn('Sweep trigger failed', { error: error instanceof Error ? error.message : String(error) });
            return;
        } finally {
            if (this.inFlight === source) {
                this.inFlight = undefined;
            }
            source.dispose();
        }
    }

    /**
     * Читает preferences, обновляет локальные поля enabled и coordinationMode,
     * и отправляет актуальный NesConfig на бекенд через nes.configure().
     */
    private async pushConfig(): Promise<void> {
        this.config = readNesConfig(this.preferences);
        this.enabled = this.preferences.get<boolean>('smart-completions.nes.enabled', true);
        this.coordinationMode = this.preferences.get<CoordinationMode>('smart-completions.coordinationMode', 'exclusive-priority');
        try {
            await this.nes.configure(this.config);
            LOG.info('Sweep controller pushed NES config', { modelId: this.config.modelId, enabled: this.enabled, coordinationMode: this.coordinationMode });
        } catch (error) {
            LOG.warn('Sweep controller failed to push config', { error: error instanceof Error ? error.message : String(error) });
        }
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
