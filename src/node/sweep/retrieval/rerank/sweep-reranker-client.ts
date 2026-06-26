import type { Neighbor } from '../../../../common/embedding-types';
import { DEFAULT_SWEEP_RERANK_INSTRUCTION } from '../../../../common/sweep/types';

/** Shared JSON headers for llama.cpp rerank requests. */
const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Near-zero score threshold that marks a misconfigured reranker server. */
const BROKEN_SCORE_EPSILON = 1e-10;

export interface RerankResult {
    index: number;
    score: number;
}

export interface SweepRerankInput {
    baseUrl: string;
    model: string;
    query: string;
    documents: string[];
    topN: number;
    timeoutMs: number;
    signal?: AbortSignal;
}

/** Клиент llama.cpp /rerank для второго этапа Sweep retrieval ranking. */
export class SweepRerankerClient {
    /** Вызывает reranker server с timeout и внешней отменой predict-запроса. */
    async rerank(input: SweepRerankInput): Promise<RerankResult[]> {
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
                body: JSON.stringify({
                    model: input.model,
                    query: input.query,
                    top_n: input.topN,
                    documents: input.documents,
                }),
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

/** Собирает Qwen3 rerank query: instruction идёт префиксом, документы остаются сырыми. */
export function buildSweepRerankQuery(instruction: string, baseQuery: string): string {
    const prefix = instruction.trim() || DEFAULT_SWEEP_RERANK_INSTRUCTION;
    return `${prefix}\nQuery: ${baseQuery}`;
}

/** Проверяет, нужна ли дорогая rerank-стадия на размытой RRF-границе topN. */
export function isAmbiguous(neighbors: Neighbor[], margin: number, finalTopN: number): boolean {
    if (neighbors.length <= finalTopN || finalTopN <= 0) {
        return false;
    }
    const accepted = neighbors[finalTopN - 1]?.score ?? 0;
    const rejected = neighbors[finalTopN]?.score ?? 0;
    return accepted - rejected < margin;
}

/** Определяет вырожденный reranker response, типичный для неверно поднятого сервера. */
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

/** Обрезает candidate document под контекст reranker модели без дополнительной разметки. */
export function clipRerankDocument(text: string, maxDocChars: number): string {
    if (maxDocChars <= 0 || text.length <= maxDocChars) {
        return text;
    }
    return text.slice(0, maxDocChars);
}

/** Нормализует base URL, чтобы клиент всегда добавлял ровно один `/rerank`. */
function trimUrl(baseUrl: string): string {
    return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

/** Парсит llama.cpp rerank JSON без доверия к лишним полям ответа. */
export function parseRerankResponse(json: unknown): RerankResult[] {
    if (!isRecord(json) || !Array.isArray(json.results)) {
        return [];
    }
    const raw = json.results;
    const out: RerankResult[] = [];
    for (let i = 0; i < raw.length; i++) {
        const item = raw[i];
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

/** Type guard для JSON objects, полученных от fetch().json(). */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
