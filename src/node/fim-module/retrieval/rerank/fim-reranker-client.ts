const JSON_HEADERS = { 'Content-Type': 'application/json' };
const BROKEN_SCORE_EPSILON = 1e-10;
export const DEFAULT_FIM_RERANK_INSTRUCTION = 'Instruct: Given the current incomplete code prefix and recent edits, judge whether the repository snippet is useful for predicting the missing code at the cursor.';

export interface RerankResult {
    index: number;
    score: number;
}

export interface FimRerankInput {
    baseUrl: string;
    model: string;
    query: string;
    documents: string[];
    topN: number;
    timeoutMs: number;
    signal?: AbortSignal;
}

export class FimRerankerClient {
    async rerank(input: FimRerankInput): Promise<RerankResult[]> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), input.timeoutMs);
        const onAbort = (): void => controller.abort();
        if (input.signal?.aborted) {
            controller.abort();
        } else {
            input.signal?.addEventListener('abort', onAbort, { once: true });
        }
        try {
            const response = await fetch(`${trimUrl(input.baseUrl)}/rerank`, {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({ model: input.model, query: input.query, top_n: input.topN, documents: input.documents }),
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new Error(`rerank ${response.status}`);
            }
            const results = parseRerankResponse(await response.json());
            return results.sort((a, b) => b.score - a.score);
        } finally {
            clearTimeout(timer);
            input.signal?.removeEventListener('abort', onAbort);
        }
    }
}

export function buildFimRerankQuery(instruction: string, baseQuery: string): string {
    return `${instruction.trim() || DEFAULT_FIM_RERANK_INSTRUCTION}\nQuery: ${baseQuery}`;
}

export function looksBroken(results: RerankResult[]): boolean {
    if (results.length === 0) {
        return true;
    }
    for (let i = 0; i < results.length; i++) {
        const score = results[i].score;
        if (Number.isFinite(score) && Math.abs(score) >= BROKEN_SCORE_EPSILON) {
            return false;
        }
    }
    return true;
}

export function clipRerankDocument(text: string, maxDocChars: number): string {
    if (maxDocChars <= 0 || text.length <= maxDocChars) {
        return text;
    }
    return text.slice(0, maxDocChars);
}

function trimUrl(baseUrl: string): string {
    return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function parseRerankResponse(json: unknown): RerankResult[] {
    if (!isRecord(json) || !Array.isArray(json.results)) {
        return [];
    }
    const out: RerankResult[] = [];
    for (let i = 0; i < json.results.length; i++) {
        const item = json.results[i];
        if (!isRecord(item) || typeof item.index !== 'number') {
            continue;
        }
        const score = typeof item.relevance_score === 'number'
            ? item.relevance_score
            : typeof item.score === 'number'
                ? item.score
                : 0;
        out.push({ index: item.index, score });
    }
    return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
