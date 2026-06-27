import { FimLogger } from '../../common/fim/logger';
import { AIX_SPAN_MIDDLE, AIX_SPAN_POST, AIX_SPAN_PRE } from '../../common/aixcoder/aixcoder-tokens';

const LOG = new FimLogger('node:aixcoder-token-healthcheck');
const PROBE_TOKENS = [AIX_SPAN_PRE, AIX_SPAN_POST, AIX_SPAN_MIDDLE];

interface TokenizeResponse {
    tokens?: number[];
}

export async function verifyAixcoderSpecialTokens(llamaUrl: string, signal?: AbortSignal): Promise<boolean> {
    const baseUrl = rawLlamaBaseUrl(llamaUrl);
    for (let index = 0; index < PROBE_TOKENS.length; index++) {
        const token = PROBE_TOKENS[index];
        const tokenIds = await tokenize(baseUrl, token, signal);
        if (tokenIds.length !== 1) {
            LOG.error(`aiXcoder special token is not preserved in GGUF: ${token} -> ${tokenIds.length} ids`);
            return false;
        }
    }
    return true;
}

export function rawLlamaBaseUrl(llamaUrl: string): string {
    try {
        const parsed = new URL(llamaUrl);
        parsed.pathname = parsed.pathname.replace(/\/v1\/?$/, '');
        return parsed.toString().replace(/\/$/, '');
    } catch {
        return llamaUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
    }
}

async function tokenize(baseUrl: string, content: string, signal?: AbortSignal): Promise<number[]> {
    const response = await fetch(`${baseUrl}/tokenize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, add_special: false, with_pieces: false }),
        signal,
    });
    if (!response.ok) {
        throw new Error(`aiXcoder tokenize failed: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as TokenizeResponse;
    return payload.tokens ?? [];
}
