import type { FimNodeModule } from '../fim-module/fim-node-module';

// Qwen2.5-Coder использует стандартные FIM-токены — health-check GGUF не нужен; контракт явный (no-op).
export const QWEN_NODE_MODULE: FimNodeModule = {
    modelId: 'qwen2.5-coder',
    specialTokens: null,
    verifySpecialTokens: async () => true,
};

export const OMNICODER_NODE_MODULE: FimNodeModule = {
    modelId: 'omnicoder',
    specialTokens: null,
    verifySpecialTokens: async () => true,
};
