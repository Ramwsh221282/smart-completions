import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Neighbor } from '../src/common/embedding-types';
import {
    buildSweepRerankQuery,
    clipRerankDocument,
    isAmbiguous,
    looksBroken,
    parseRerankResponse,
    SweepRerankerClient,
} from '../src/node/sweep/retrieval/rerank/sweep-reranker-client';

/** Создаёт Neighbor с заданным score для проверки rerank policy на RRF шкале. */
function neighbor(score: number): Neighbor {
    return { filePath: 'a.ts', startLine: 1, endLine: 1, text: 'text', score };
}

/** Проверяет Qwen3 формат: instruction префиксом в query, documents остаются сырыми. */
test('buildSweepRerankQuery prepends instruction and Query label', () => {
    const query = buildSweepRerankQuery('Instruct: rank snippets', 'displayName fullName');
    assert.equal(query, 'Instruct: rank snippets\nQuery: displayName fullName');
});

/** Проверяет парсинг llama.cpp /rerank ответа и сортировку на уровне клиента. */
test('SweepRerankerClient posts /rerank and sorts relevance_score results', async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody = '';
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        capturedBody = String(init?.body ?? '');
        return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: -5 }, { index: 1, relevance_score: 8 }] }), { status: 200 });
    };
    try {
        const client = new SweepRerankerClient();
        const results = await client.rerank({
            baseUrl: 'http://127.0.0.1:8040/v1',
            model: 'qwen3-reranker-0.6b',
            query: 'Instruct: rank\nQuery: symbol',
            documents: ['raw doc 0', 'raw doc 1'],
            topN: 2,
            timeoutMs: 1000,
        });

        assert.deepEqual(results.map(result => result.index), [1, 0]);
        assert.equal(JSON.parse(capturedBody).documents[0], 'raw doc 0');
        assert.equal(JSON.parse(capturedBody).query, 'Instruct: rank\nQuery: symbol');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

/** Проверяет tolerant parser: старое поле score и новое relevance_score приводятся к одному виду. */
test('parseRerankResponse accepts relevance_score and score fields', () => {
    const parsed = parseRerankResponse({ results: [{ index: 0, relevance_score: 1.5 }, { index: 1, score: -0.5 }] });
    assert.deepEqual(parsed, [{ index: 0, score: 1.5 }, { index: 1, score: -0.5 }]);
});

/** Проверяет ambiguity gate на realistic RRF gaps: 0.002 не должен включать rerank всегда. */
test('isAmbiguous uses a small RRF-scale margin', () => {
    assert.equal(isAmbiguous([neighbor(0.030), neighbor(0.025), neighbor(0.020), neighbor(0.019)], 0.002, 3), true);
    assert.equal(isAmbiguous([neighbor(0.030), neighbor(0.025), neighbor(0.020), neighbor(0.014)], 0.002, 3), false);
});

/** Проверяет runtime-страховку от вырожденных scores при неверно поднятом reranker server. */
test('looksBroken detects degenerate reranker scores', () => {
    assert.equal(looksBroken([{ index: 0, score: 1e-20 }, { index: 1, score: 0 }]), true);
    assert.equal(looksBroken([{ index: 0, score: -5.38 }]), false);
});

/** Проверяет ограничение document context без добавления Qwen-specific разметки к документам. */
test('clipRerankDocument clips only long documents', () => {
    assert.equal(clipRerankDocument('abcdef', 3), 'abc');
    assert.equal(clipRerankDocument('abcdef', 10), 'abcdef');
});
