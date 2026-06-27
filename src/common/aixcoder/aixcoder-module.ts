import type { FimModelModule } from '../fim/fim-model-module';
import { renderAixcoderPrompt, buildAixcoderEditSnippets } from './aixcoder-prompt-builder';
import { AIXCODER_CONTEXT_TOKENS, AIXCODER_TOKENS } from './aixcoder-tokens';
import { buildAixcoderHeader } from './aixcoder-header';

export const AIXCODER_MODULE: FimModelModule = {
    modelId: 'aixcoder-7b-v2',
    templateId: 'aixcoder',
    llamaModel: 'aixcoder-7b-v2',
    tokens: AIXCODER_TOKENS,
    supportsRepoContext: true,
    repoFormat: 'aixcoder',
    contextTokens: AIXCODER_CONTEXT_TOKENS,
    embedderId: 'qwen3-0.6b',
    renderPrompt: input => renderAixcoderPrompt({
        languageId: input.languageId,
        filePath: input.filePath,
        prefix: input.prefix,
        suffix: input.suffix,
        neighbors: input.neighbors,
        relatedFiles: input.relatedFiles,
        editSnippets: input.editSnippets,
    }),
    buildEditSnippets: (languageId, recentEdits, maxEdits) => buildAixcoderEditSnippets(languageId, recentEdits, maxEdits),
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
};

function countReservedChars(input: Parameters<FimModelModule['countReservedChars']>[0]): number {
    return input.neighbors.reduce((sum, neighbor) => sum + buildAixcoderHeader(neighbor.filePath, input.languageId).length + neighbor.text.length + 1, 0)
        + input.relatedFiles.reduce((sum, file) => sum + buildAixcoderHeader(file.filePath, input.languageId).length + file.content.length + 1, 0)
        + input.editSnippets.reduce((sum, snippet) => sum + snippet.length + 1, 0);
}
