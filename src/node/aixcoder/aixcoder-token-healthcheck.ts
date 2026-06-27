import { AIX_SPAN_MIDDLE, AIX_SPAN_POST, AIX_SPAN_PRE } from '../../common/aixcoder/aixcoder-tokens';
import { rawLlamaBaseUrl, verifySpecialTokensPreserved } from '../fim-module/model-call/llama-tokenize';

const PROBE_TOKENS = [AIX_SPAN_PRE, AIX_SPAN_POST, AIX_SPAN_MIDDLE];

export async function verifyAixcoderSpecialTokens(llamaUrl: string, signal?: AbortSignal): Promise<boolean> {
    return verifySpecialTokensPreserved(llamaUrl, PROBE_TOKENS, 'aiXcoder', signal);
}

export { rawLlamaBaseUrl };
