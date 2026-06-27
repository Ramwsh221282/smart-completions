import type { FimModelModule } from '../fim/fim-model-module';
import { DEEPSEEK_TOKENS } from '../qwen25/qwen-tokens';

export const DEEPSEEK_MODULE: FimModelModule = {
    modelId: 'deepseek-coder',
    templateId: 'deepseek',
    llamaModel: 'deepseek-coder',
    tokens: DEEPSEEK_TOKENS,
    supportsRepoContext: false,
    repoFormat: null,
    contextTokens: 16384,
    embedderId: 'jina-code',
    renderPrompt: input => `${DEEPSEEK_TOKENS.prefix}${input.prefix}${DEEPSEEK_TOKENS.suffix}${input.suffix}${DEEPSEEK_TOKENS.middle}`,
    buildEditSnippets: () => [],
    countReservedChars: () => 0,
    maxTokensForMode: generationMode => {
        if (generationMode === 'line') {
            return 48;
        }
        if (generationMode === 'block') {
            return 384;
        }
        return 160;
    },
};
