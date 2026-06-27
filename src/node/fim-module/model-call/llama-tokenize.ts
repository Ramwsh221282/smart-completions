import { FimLogger } from '../../../common/fim/logger';

const LOG = new FimLogger('node:llama-tokenize');

interface TokenizeResponse {
    tokens?: number[];
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

export async function verifySpecialTokensPreserved(
    llamaUrl: string,
    tokens: string[],
    label: string,
    signal?: AbortSignal,
): Promise<boolean> {
    const baseUrl = rawLlamaBaseUrl(llamaUrl);
    for (let i = 0; i < tokens.length; i++) {
        const tokenIds = await tokenize(baseUrl, tokens[i], signal);
        if (tokenIds.length !== 1) {
            LOG.error(`${label} special token not preserved in GGUF: ${tokens[i]} -> ${tokenIds.length} ids`);
            return false;
        }
    }
    return true;
}

async function tokenize(baseUrl: string, content: string, signal?: AbortSignal): Promise<number[]> {
    const response = await fetch(`${baseUrl}/tokenize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, add_special: false, with_pieces: false }),
        signal,
    });
    if (!response.ok) {
        throw new Error(`llama tokenize failed: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as TokenizeResponse;
    return payload.tokens ?? [];
}
