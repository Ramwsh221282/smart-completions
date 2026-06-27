import { buildEditHistorySnippets } from '../fim/fim-udiff';
import type { FimModelModule, FimPromptRenderInput } from '../fim/fim-model-module';
import { QWEN_FILE_TOKEN, QWEN_TOKENS } from './qwen-tokens';
import { renderQwenPrompt } from './qwen-prompt-builder';

const DEFAULT_CONTEXT_TOKENS = 32768;
const RESERVED_CONTEXT_CHARS = 8;

export const QWEN_MODULE: FimModelModule = {
    modelId: 'qwen2.5-coder',
    templateId: 'qwen',
    llamaModel: 'qwen2.5-coder',
    tokens: QWEN_TOKENS,
    supportsRepoContext: true,
    repoFormat: 'file-sep',
    contextTokens: DEFAULT_CONTEXT_TOKENS,
    embedderId: 'jina-code',
    renderPrompt: input => renderQwenPrompt({ ...input, tokens: QWEN_TOKENS }),
    buildEditSnippets: (languageId, recentEdits, maxEdits) => {
        void languageId;
        return buildEditHistorySnippets(QWEN_FILE_TOKEN, recentEdits, maxEdits);
    },
    countReservedChars: input => countRepoReservedChars(input),
    maxTokensForMode: generationMode => maxTokensForMode(generationMode),
};

export const OMNICODER_MODULE: FimModelModule = {
    ...QWEN_MODULE,
    modelId: 'omnicoder',
    llamaModel: 'omnicoder',
};

function countRepoReservedChars(input: FimPromptRenderInput): number {
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
