import type { FimModelModule, FimPromptRenderInput } from '../fim/fim-model-module';
import { GRANITE_TOKENS } from './granite-tokens';
import { renderGranitePrompt, buildGraniteEditSnippets } from './granite-prompt-builder';

const RESERVED_CONTEXT_CHARS = 8;

export const GRANITE_8B_MODULE: FimModelModule = {
    modelId: 'granite-4.1-8b',
    templateId: 'granite',
    llamaModel: 'granite-4.1-8b',
    tokens: GRANITE_TOKENS,
    supportsRepoContext: true,
    repoFormat: 'comment',
    contextTokens: 128000,
    embedderId: 'qwen3-0.6b',
    renderPrompt: input => renderPrompt(input),
    buildEditSnippets: (languageId, recentEdits, maxEdits) => buildGraniteEditSnippets(languageId, recentEdits, maxEdits),
    countReservedChars: input => countReservedChars(input),
    maxTokensForMode: generationMode => maxTokensForMode(generationMode),
    verifySpecialTokens: null,
};

export const GRANITE_3B_MODULE: FimModelModule = {
    ...GRANITE_8B_MODULE,
    modelId: 'granite-4.1-3b',
    llamaModel: 'granite-4.1-3b',
};

function renderPrompt(input: FimPromptRenderInput): string {
    if (!input.useRepoContext) {
        return `${GRANITE_TOKENS.prefix}${input.prefix}${GRANITE_TOKENS.suffix}${input.suffix}${GRANITE_TOKENS.middle}`;
    }
    return renderGranitePrompt({
        languageId: input.languageId,
        filePath: input.filePath,
        prefix: input.prefix,
        suffix: input.suffix,
        neighbors: input.neighbors,
        relatedFiles: input.relatedFiles,
        editSnippets: input.editSnippets,
        tokens: GRANITE_TOKENS,
    });
}

function countReservedChars(input: FimPromptRenderInput): number {
    return input.neighbors.reduce((sum, neighbor) => sum + neighbor.text.length + neighbor.filePath.length + RESERVED_CONTEXT_CHARS, 0)
        + input.relatedFiles.reduce((sum, file) => sum + file.content.length + file.filePath.length + RESERVED_CONTEXT_CHARS, 0)
        + input.editSnippets.reduce((sum, snippet) => sum + snippet.length, 0);
}

function maxTokensForMode(generationMode: 'line' | 'multiline' | 'block'): number {
    if (generationMode === 'line') {
        return 48;
    }
    if (generationMode === 'block') {
        return 384;
    }
    return 160;
}
