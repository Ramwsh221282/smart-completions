import type { FimNodeModule } from '../fim-module/fim-node-module';

// DeepSeek-Coder — стандартные FIM-токены; health-check не требуется.
export const DEEPSEEK_NODE_MODULE: FimNodeModule = {
    modelId: 'deepseek-coder',
    specialTokens: null,
    verifySpecialTokens: async () => true,
};
