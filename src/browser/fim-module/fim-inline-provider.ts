import { injectable, inject } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { CancellationTokenSource, Disposable, DisposableCollection } from '@theia/core/lib/common';
import { PreferenceChange, PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import * as monaco from '@theia/monaco-editor-core';
import type { FimConfig, FimRequest } from '../../common/fim-types';
import type { CoordinationMode } from '../../common/model-types';
import type { FileMode } from '../../common/mode-types';
import { FimBackendService } from '../../common/protocol';
import { FimContextCollector } from './data-gathering-layer/fim-context-collector';
import { FimCompletionCache, type FimCacheKeyInput } from './fim-completion-cache';
import { NesViewZoneRenderer } from '../nes-render/nes-view-zone-renderer';
import { readFimConfig } from '../preferences/preferences-schema';
import { fileModeForLanguage } from '../shared/file-mode';

@injectable()
export class FimInlineProvider implements FrontendApplicationContribution, monaco.languages.InlineCompletionsProvider, Disposable {
    @inject(FimBackendService) private readonly fim!: FimBackendService;
    @inject(FimCompletionCache) private readonly cache!: FimCompletionCache;
    @inject(FimContextCollector) private readonly collector!: FimContextCollector;
    @inject(PreferenceService) private readonly preferences!: PreferenceService;
    @inject(NesViewZoneRenderer) private readonly nesRenderer!: NesViewZoneRenderer;

    private readonly toDispose = new DisposableCollection();
    private config!: FimConfig;
    private enabled = true;
    private coordinationMode: CoordinationMode = 'exclusive-priority';
    debounceDelayMs = 120;
    displayName = 'Smart Completions FIM';

    async onStart(): Promise<void> {
        await this.pushConfig();
        this.toDispose.push(monaco.languages.registerInlineCompletionsProvider([{ scheme: 'file' }, { scheme: 'untitled' }], this));
        this.toDispose.push(this.preferences.onPreferenceChanged((event: PreferenceChange) => {
            if (event.preferenceName.startsWith('smart-completions.fim') || event.preferenceName === 'smart-completions.coordinationMode') {
                void this.pushConfig();
            }
        }));
    }

    async provideInlineCompletions(
        model: monaco.editor.ITextModel,
        position: monaco.Position,
        context: monaco.languages.InlineCompletionContext,
        token: monaco.CancellationToken,
    ): Promise<monaco.languages.InlineCompletions | undefined> {
        if (!this.enabled || this.coordinationMode === 'nes-only') {
            return undefined;
        }
        if (this.coordinationMode === 'nes-priority' && this.nesRenderer.isVisible()) {
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
        this.coordinationMode = this.preferences.get<CoordinationMode>('smart-completions.coordinationMode', 'exclusive-priority');
        this.debounceDelayMs = this.config.debounceMs;
        this.cache.clear();
    }

    private async requestFreshCompletion(
        model: monaco.editor.ITextModel,
        position: monaco.Position,
        prepared: PreparedFimRequest,
        token: monaco.CancellationToken,
    ): Promise<monaco.languages.InlineCompletions | undefined> {
        const source = new CancellationTokenSource();
        const listener = token.onCancellationRequested(() => source.cancel());
        try {
            const fimContext = await this.collectContext(model, position);
            const response = await this.fim.complete({
                requestId: createRequestId(),
                ...prepared.request,
                relatedFiles: fimContext.relatedFiles,
                recentEdits: fimContext.recentEdits,
            }, source.token);
            if (token.isCancellationRequested || !response.text) {
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

function shouldTrigger(model: monaco.editor.ITextModel, position: monaco.Position, fileMode: 'code' | 'prose'): boolean {
    // Автотриггер ограничен небольшим набором символов, чтобы FIM срабатывал после естественных boundary,
    // а не на каждом keystroke внутри слова или в середине уже печатаемого идентификатора.
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
