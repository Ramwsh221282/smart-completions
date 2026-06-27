import { SEED_FIM_MIDDLE, SEED_FIM_PREFIX, SEED_FIM_SUFFIX } from '../../common/seedcoder/seed-tokens';
import type { FimNodeModule } from '../fim-module/fim-node-module';
import { verifySpecialTokensPreserved } from '../fim-module/model-call/llama-tokenize';

// Скобочные <[fim-*]> токены Seed требуют проверки сохранности в GGUF.
const PROBE_TOKENS = [SEED_FIM_SUFFIX, SEED_FIM_PREFIX, SEED_FIM_MIDDLE];

export const SEED_NODE_MODULE: FimNodeModule = {
    modelId: 'seed-coder-8b',
    specialTokens: PROBE_TOKENS,
    verifySpecialTokens: (llamaUrl, signal) => verifySpecialTokensPreserved(llamaUrl, PROBE_TOKENS, 'Seed-Coder', signal),
};
