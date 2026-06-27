import type { FimNodeModule } from '../fim-module/fim-node-module';

// Granite-4.1 использует те же стандартные FIM-токены, что Qwen; health-check не требуется.
export const GRANITE_8B_NODE_MODULE: FimNodeModule = {
    modelId: 'granite-4.1-8b',
    specialTokens: null,
    verifySpecialTokens: async () => true,
};

export const GRANITE_3B_NODE_MODULE: FimNodeModule = {
    modelId: 'granite-4.1-3b',
    specialTokens: null,
    verifySpecialTokens: async () => true,
};
