import { SEED_FIM_MIDDLE, SEED_FIM_PREFIX, SEED_FIM_SUFFIX } from '../../common/seedcoder/seed-tokens';
import { verifySpecialTokensPreserved } from '../fim-module/model-call/llama-tokenize';

const PROBE_TOKENS = [SEED_FIM_SUFFIX, SEED_FIM_PREFIX, SEED_FIM_MIDDLE];

export async function verifySeedSpecialTokens(llamaUrl: string, signal?: AbortSignal): Promise<boolean> {
    return verifySpecialTokensPreserved(llamaUrl, PROBE_TOKENS, 'Seed-Coder', signal);
}
