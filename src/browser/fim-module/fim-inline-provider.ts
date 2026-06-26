import { injectable, inject } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { CancellationTokenSource, Disposable, DisposableCollection } from '@theia/core/lib/common';
import { PreferenceChange, PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import * as monaco from '@theia/monaco-editor-core';
import { FimConfig } from '../../common/fim-types';
import { CoordinationMode } from '../../common/model-types';
import { FimBackendService } from '../../common/protocol';
import { FimContextCollector } from './data-gathering-layer/fim-context-collector';
import { NesViewZoneRenderer } from '../nes-render/nes-view-zone-renderer';
import { readFimConfig } from '../preferences/preferences-schema';
import { fileModeForLanguage } from '../shared/file-mode';

@injectable()
export class FimInlineProvider implements FrontendApplicationContribution, monaco.languages.InlineCompletionsProvider, Disposable {
    @inject(FimBackendService) private readonly fim!: FimBackendService;
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
        const source = new CancellationTokenSource();
        const listener = token.onCancellationRequested(() => source.cancel());
        try {
            const fimContext = shouldCollectFimContext(this.config)
                ? await this.collector.collect({
                    model,
                    position,
                    collectRecentEdits: this.config.contextSources.recentEdits,
                    collectRelatedFiles: this.config.contextSources.repoContext,
                })
                : { recentEdits: [], relatedFiles: [] };
            const response = await this.fim.complete({
                requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                uri: model.uri.toString(),
                languageId: model.getLanguageId(),
                fileMode,
                prefix: model.getValueInRange({
                    startLineNumber: 1,
                    startColumn: 1,
                    endLineNumber: position.lineNumber,
                    endColumn: position.column,
                }),
                suffix: model.getValueInRange({
                    startLineNumber: position.lineNumber,
                    startColumn: position.column,
                    endLineNumber: model.getLineCount(),
                    endColumn: model.getLineMaxColumn(model.getLineCount()),
                }),
                generationMode: this.config.generationMode,
                relatedFiles: fimContext.relatedFiles,
                recentEdits: fimContext.recentEdits,
            }, source.token);
            if (token.isCancellationRequested || !response.text) {
                return undefined;
            }
            return {
                items: [{
                    insertText: response.text,
                    range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
                }],
                suppressSuggestions: false,
            };
        } finally {
            listener.dispose();
            source.dispose();
        }
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
    }
}

function shouldCollectFimContext(config: FimConfig): boolean {
    return config.contextSources.recentEdits || config.contextSources.repoContext;
}

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
