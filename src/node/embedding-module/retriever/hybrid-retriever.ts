import { Neighbor } from '../../../common/embedding-types';
import { VectorHit, VectorStore } from '../vector-store/iface';
import { Bm25Index } from '../vector-store/bm25-index';
import { EmbedClient } from '../embed-client/llama-embed-client';

const RRF_K = 60;

/**
 * Слияние нескольких ранжированных списков через Reciprocal Rank Fusion.
 * score(doc) = Σ 1/(k + rank), rank 0-based. Возвращает top-N.
 * Экспортируется отдельно для юнит-тестов.
 */
export function reciprocalRankFusion(lists: VectorHit[][], topN: number, k = RRF_K): VectorHit[] {
    const score = new Map<string, number>();
    const best = new Map<string, VectorHit>();
    for (let i = 0; i < lists.length; i++) {
        const list = lists[i];
        for (let rank = 0; rank < list.length; rank++) {
            const hit = list[rank];
            const id = hit.record.id;
            score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1));
            if (!best.has(id)) {
                best.set(id, hit);
            }
        }
    }
    const ranked = Array.from(score.entries()).sort((a, b) => b[1] - a[1]);
    const count = Math.min(topN, ranked.length);
    const out = new Array<VectorHit>(count);
    for (let i = 0; i < count; i++) {
        const [id, s] = ranked[i];
        out[i] = { record: best.get(id)!.record, score: s };
    }
    return out;
}

export interface RetrieveRequest {
    /** Поисковый запрос = хвост префикса (+ при необходимости текст недавних правок). */
    queryText: string;
    /** Отдельный текст для векторной ветки нужен FIM-эмбеддерам с instruction-префиксом. */
    vectorQueryText?: string;
    topN: number;
    signal?: AbortSignal;
}

/**
 * Гибридный поиск: вектор (cosine) + BM25, слияние RRF (k=60).
 * Вектора ловят семантику, BM25 — точные совпадения по именам.
 * При сбое эмбеддинга/вектора деградирует до чисто лексического (не блокирует подсказку).
 */
export class HybridRetriever {
    constructor(
        private readonly store: VectorStore,
        private readonly bm25: Bm25Index,
        private readonly embed: EmbedClient,
    ) {}

    async retrieve(request: RetrieveRequest): Promise<Neighbor[]> {
        const { queryText, vectorQueryText = queryText, topN, signal } = request;
        if (!queryText.trim() || topN <= 0) {
            return [];
        }
        const fetchN = topN * 2; // top-2N из каждого источника → переранжирование в top-N

        let vectorHits: VectorHit[] = [];
        try {
            const vectors = await this.embed.embed([vectorQueryText], signal);
            if (vectors[0] && !signal?.aborted) {
                vectorHits = await this.store.vectorSearch(vectors[0], fetchN);
            }
        } catch {
            // деградация до лексического поиска
        }

        const lexicalHits = this.bm25.search(queryText, fetchN);
        const merged = reciprocalRankFusion([vectorHits, lexicalHits], topN);

        return merged.map(hit => ({
            filePath: hit.record.filePath,
            startLine: hit.record.startLine,
            endLine: hit.record.endLine,
            text: hit.record.text,
            score: hit.score,
        }));
    }
}
