import { AIX_SPAN_MIDDLE, AIX_SPAN_POST, AIX_SPAN_PRE } from '../../common/aixcoder/aixcoder-tokens';
import type { FimNodeModule } from '../fim-module/fim-node-module';
import { verifySpecialTokensPreserved } from '../fim-module/model-call/llama-tokenize';

// Экзотические AIX-SPAN токены требуют проверки сохранности в GGUF (иначе формат сломан).
const PROBE_TOKENS = [AIX_SPAN_PRE, AIX_SPAN_POST, AIX_SPAN_MIDDLE];

export const AIXCODER_NODE_MODULE: FimNodeModule = {
    modelId: 'aixcoder-7b-v2',
    specialTokens: PROBE_TOKENS,
    verifySpecialTokens: (llamaUrl, signal) => verifySpecialTokensPreserved(llamaUrl, PROBE_TOKENS, 'aiXcoder', signal),
};
