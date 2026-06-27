import type { FimModelModule, FimPromptRenderInput } from '../fim/fim-model-module';
import { lineCommentForLanguage } from '../granite41/line-comment';
import { buildSeedEditSnippets, renderSeedPrompt } from './seed-prompt-builder';
import { SEED_CONTEXT_TOKENS, SEED_FIM_MIDDLE, SEED_FIM_PREFIX, SEED_FIM_SUFFIX, SEED_TOKENS } from './seed-tokens';

export const SEED_MODULE: FimModelModule = {
    modelId: 'seed-coder-8b',
    templateId: 'seed',
    llamaModel: 'seed-coder-8b',
    tokens: SEED_TOKENS,
    supportsRepoContext: true,
    repoFormat: 'seed',
    contextTokens: SEED_CONTEXT_TOKENS,
    embedderId: 'qwen3-0.6b',
    renderPrompt: input => renderPrompt(input),
    buildEditSnippets: (languageId, recentEdits, maxEdits) => buildSeedEditSnippets(languageId, recentEdits, maxEdits),
    countReservedChars: input => countReservedChars(input),
    maxTokensForMode: generationMode => {
        if (generationMode === 'line') {
            return 64;
        }
        if (generationMode === 'block') {
            return 512;
        }
        return 256;
    },
    verifySpecialTokens: async (llamaUrl, signal) => {
        const { verifySeedSpecialTokens } = await import('../../node/seedcoder/seed-token-healthcheck.js');
        return verifySeedSpecialTokens(llamaUrl, signal);
    },
};

function renderPrompt(input: FimPromptRenderInput): string {
    if (!input.useRepoContext) {
        return `${SEED_FIM_SUFFIX}${input.suffix}${SEED_FIM_PREFIX}${input.prefix}${SEED_FIM_MIDDLE}`;
    }
    return renderSeedPrompt({
        languageId: input.languageId,
        filePath: input.filePath,
        prefix: input.prefix,
        suffix: input.suffix,
        neighbors: input.neighbors,
        relatedFiles: input.relatedFiles,
        editSnippets: input.editSnippets,
    });
}

function countReservedChars(input: FimPromptRenderInput): number {
    const comment = lineCommentForLanguage(input.languageId);
    return input.neighbors.reduce((sum, neighbor) => sum + comment.length + 1 + neighbor.filePath.length + 1 + neighbor.text.length, 0)
        + input.relatedFiles.reduce((sum, file) => sum + comment.length + 1 + file.filePath.length + 1 + file.content.length, 0)
        + input.editSnippets.reduce((sum, snippet) => sum + snippet.length + 1, 0)
        + comment.length + 1 + input.filePath.length + 1;
}
