import { injectable, inject } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { CancellationTokenSource, Disposable, DisposableCollection } from '@theia/core/lib/common';
import { PreferenceChange, PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import * as monaco from '@theia/monaco-editor-core';
import type { FimConfig, FimRequest } from '../../common/fim-types';
import type { FileMode } from '../../common/mode-types';
import { FimBackendService } from '../../common/protocol';
import { CoreBackendService } from '../../common/core/core-protocol';
import { FimContextCollector } from './data-gathering-layer/fim-context-collector';
import { FimCompletionCache, type FimCacheKeyInput } from './fim-completion-cache';
import { readFimConfig } from '../preferences/preferences-schema';
import { fileModeForLanguage } from '../shared/file-mode';

/** Регистрирует Monaco inline completions provider для FIM ghost text независимо от NES pipeline. */
@injectable()
export class FimInlineProvider implements FrontendApplicationContribution, monaco.languages.InlineCompletionsProvider, Disposable {
    @inject(FimBackendService) private readonly fim!: FimBackendService;
    @inject(CoreBackendService) private readonly core!: CoreBackendService;
    @inject(FimCompletionCache) private readonly cache!: FimCompletionCache;
    @inject(FimContextCollector) private readonly collector!: FimContextCollector;
    @inject(PreferenceService) private readonly preferences!: PreferenceService;

    private readonly toDispose = new DisposableCollection();
    private config!: FimConfig;
    // Флаг включения FIM из настроек; единственный gate для inline completions.
    private enabled = true;
    // Опциональный путь через Rust-core; при пустом результате/ошибке откатываемся на TS backend.
    private coreEnabled = false;
    // Монотонный numeric id запроса для корреляции стрима фреймов в core.
    private requestCounter = 0;
    debounceDelayMs = 120;
    displayName = 'Smart Completions FIM';

    /** Регистрирует inline completions provider и подписывается на изменения FIM-настроек. */
    async onStart(): Promise<void> {
        await this.pushConfig();
        this.toDispose.push(monaco.languages.registerInlineCompletionsProvider([{ scheme: 'file' }, { scheme: 'untitled' }], this));
        this.toDispose.push(this.preferences.onPreferenceChanged((event: PreferenceChange) => {
            if (
                event.preferenceName.startsWith('smart-completions.fim') ||
                event.preferenceName.startsWith('smart-completions.core')
            ) {
                void this.pushConfig();
            }
        }));
    }

    /** Обрабатывает Monaco inline completions запрос; gate только по fim.enabled и trigger rules. */
    async provideInlineCompletions(
        model: monaco.editor.ITextModel,
        position: monaco.Position,
        context: monaco.languages.InlineCompletionContext,
        token: monaco.CancellationToken,
    ): Promise<monaco.languages.InlineCompletions | undefined> {
        if (!this.enabled) {
            return undefined;
        }
        const fileMode = fileModeForLanguage(model.getLanguageId());
        if (context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Automatic && !shouldTrigger(model, position, fileMode)) {
            return undefined;
        }
        const prepared = prepareFimRequest(model, position, fileMode, this.config.generationMode);
        const cached = this.cache.lookup(prepared.cacheKey);
        if (cached !== null) {
            return toInlineCompletions(prepared.range, cached);
        }
        return this.requestFreshCompletion(model, position, prepared, token);
    }

    disposeInlineCompletions(): void {}

    dispose(): void {
        this.toDispose.dispose();
    }

    private async pushConfig(): Promise<void> {
        this.config = readFimConfig(this.preferences);
        this.enabled = this.preferences.get<boolean>('smart-completions.fim.enabled', true);
        this.coreEnabled = this.preferences.get<boolean>('smart-completions.core.enabled', false);
        this.debounceDelayMs = this.config.debounceMs;
        this.cache.clear();
    }

    /**
     * Выполняет backend-запрос с staleness guard: если версия модели изменилась
     * за время async context collection или completion, результат отбрасывается.
     */
    private async requestFreshCompletion(
        model: monaco.editor.ITextModel,
        position: monaco.Position,
        prepared: PreparedFimRequest,
        token: monaco.CancellationToken,
    ): Promise<monaco.languages.InlineCompletions | undefined> {
        const version = model.getVersionId();
        if (this.coreEnabled) {
            const fromCore = await this.tryCoreCompletion(model, position, prepared, version, token);
            if (fromCore !== undefined) {
                return fromCore;
            }
        }
        const source = new CancellationTokenSource();
        const listener = token.onCancellationRequested(() => source.cancel());
        try {
            const fimContext = await this.collectContext(model, position);
            if (token.isCancellationRequested || model.getVersionId() !== version) {
                return undefined;
            }
            const response = await this.fim.complete({
                requestId: createRequestId(),
                ...prepared.request,
                relatedFiles: fimContext.relatedFiles,
                recentEdits: fimContext.recentEdits,
            }, source.token);
            if (token.isCancellationRequested || model.getVersionId() !== version || !response.text) {
                return undefined;
            }
            this.cache.store(prepared.cacheKey, response.text);
            return toInlineCompletions(prepared.range, response.text);
        } finally {
            listener.dispose();
            source.dispose();
        }
    }

    private collectContext(model: monaco.editor.ITextModel, position: monaco.Position) {
        if (!shouldCollectFimContext(this.config)) {
            return Promise.resolve({ recentEdits: [], relatedFiles: [] });
        }
        return this.collector.collect({
            model,
            position,
            collectRecentEdits: this.config.contextSources.recentEdits,
            collectRelatedFiles: this.config.contextSources.repoContext,
        });
    }

    /**
     * Пытается получить completion из Rust-core. Возвращает undefined при пустом
     * ответе, ошибке или устаревшей версии модели, чтобы вызвавший код откатился
     * на TS backend.
     */
    private async tryCoreCompletion(
        model: monaco.editor.ITextModel,
        position: monaco.Position,
        prepared: PreparedFimRequest,
        version: number,
        token: monaco.CancellationToken,
    ): Promise<monaco.languages.InlineCompletions | undefined> {
        try {
            const result = await this.core.requestCompletion({
                requestId: this.nextRequestId(),
                mode: 'fim',
                modelId: this.config.modelId,
                uri: prepared.request.uri,
                version,
                fileMode: prepared.request.fileMode,
                cursor: {
                    lineNumber: position.lineNumber,
                    column: position.column,
                    offset: model.getOffsetAt(position),
                },
                configVersion: 0,
            });
            if (!result.accepted || !result.text) {
                return undefined;
            }
            if (token.isCancellationRequested || model.getVersionId() !== version) {
                return undefined;
            }
            this.cache.store(prepared.cacheKey, result.text);
            return toInlineCompletions(prepared.range, result.text);
        } catch {
            return undefined;
        }
    }

    private nextRequestId(): number {
        this.requestCounter += 1;
        return this.requestCounter;
    }
}

interface PreparedFimRequest {
    cacheKey: FimCacheKeyInput;
    range: monaco.Range;
    request: PreparedFimPayload;
}

type PreparedFimPayload = Pick<FimRequest, 'uri' | 'languageId' | 'fileMode' | 'prefix' | 'suffix' | 'generationMode'>;

function prepareFimRequest(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    fileMode: FileMode,
    generationMode: FimConfig['generationMode'],
): PreparedFimRequest {
    const uri = model.uri.toString();
    const prefix = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
    });
    const suffix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: model.getLineCount(),
        endColumn: model.getLineMaxColumn(model.getLineCount()),
    });
    return {
        cacheKey: { uri, fileMode, generationMode, prefix, suffix },
        range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
        request: {
            uri,
            languageId: model.getLanguageId(),
            fileMode,
            prefix,
            suffix,
            generationMode,
        },
    };
}

function createRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toInlineCompletions(range: monaco.Range, insertText: string): monaco.languages.InlineCompletions {
    return {
        items: [{ insertText, range }],
        suppressSuggestions: false,
    };
}

function shouldCollectFimContext(config: FimConfig): boolean {
    return config.contextSources.recentEdits || config.contextSources.repoContext;
}

/** Ограничивает автотриггер FIM допустимыми символами-разделителями, чтобы не срабатывать внутри слова. */
function shouldTrigger(model: monaco.editor.ITextModel, position: monaco.Position, fileMode: 'code' | 'prose'): boolean {
    if (position.column < model.getLineMaxColumn(position.lineNumber)) {
        const next = model.getLineContent(position.lineNumber).charAt(position.column - 1);
        if (/\w/.test(next)) {
            return false;
        }
    }
    const previous = previousCharacter(model, position);
    if (!previous) {
        return false;
    }
    if (fileMode === 'code') {
        return /[ \t\n{:.]/.test(previous);
    }
    return /[ \n.!?]/.test(previous);
}

function previousCharacter(model: monaco.editor.ITextModel, position: monaco.Position): string {
    if (position.column > 1) {
        return model.getLineContent(position.lineNumber).charAt(position.column - 2);
    }
    return position.lineNumber > 1 ? '\n' : '';
}
