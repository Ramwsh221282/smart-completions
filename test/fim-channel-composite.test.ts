import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Neighbor } from '../src/common/embedding-types';
import type { FimRetrievalConfig } from '../src/common/fim-types';
import type { RetrievalChannel } from '../src/node/fim-module/retrieval/fim-retrieval-channel';
import { FimRetrievalOrchestrator } from '../src/node/fim-module/retrieval/fim-retrieval-orchestrator';

function neighbor(filePath: string, score = 1): Neighbor {
    return { filePath, startLine: 1, endLine: 2, text: filePath, score };
}

function channel(id: string, codeOnly: boolean, enabled: boolean, out: Neighbor[]): RetrievalChannel {
    return { id, codeOnly, isEnabled: () => enabled, retrieve: () => out };
}

function config(rerankEnabled = false, graphEnabled = true, fuzzyEnabled = true): FimRetrievalConfig {
    return {
        rerank: {
            enabled: rerankEnabled,
            llamaUrl: 'http://127.0.0.1:8030/v1',
            model: 'Qwen3-Reranker-0.6B',
            instruction: 'rerank',
            candidatePoolN: 10,
            rerankTopN: 10,
            finalTopN: 10,
            ambiguityMargin: 0.002,
            timeoutMs: 200,
            maxDocChars: 2000,
        },
        graph: { enabled: graphEnabled },
        fuzzy: { enabled: fuzzyEnabled },
    };
}

function input(fileMode: 'code' | 'prose') {
    return {
        query: 'q',
        fileMode,
        signals: { cursorSymbol: 's', renamedSymbols: [], diagnosticSymbols: [], importedSymbols: [] },
        fuzzySymbols: ['s'],
        topN: 10,
    };
}

test('FimRetrievalOrchestrator includes channels in registration order for code mode', async () => {
    const orchestrator = new FimRetrievalOrchestrator([
        channel('semantic', false, true, [neighbor('s.ts')]),
        channel('graph', true, true, [neighbor('g.ts')]),
        channel('fuzzy', true, true, [neighbor('f.ts')]),
    ]);

    const out = await orchestrator.retrieve(input('code'), config());

    assert.deepEqual(out.map(item => item.filePath), ['s.ts', 'g.ts', 'f.ts']);
});

test('FimRetrievalOrchestrator reranks unconditionally when rerank is enabled', async () => {
    const orchestrator = new FimRetrievalOrchestrator([
        channel('semantic', false, true, [neighbor('first.ts')]),
        channel('graph', true, true, [neighbor('second.ts')]),
    ]);
    const patched = orchestrator as unknown as { reranker: { rerank: () => Promise<Array<{ index: number; score: number }>> } };
    patched.reranker = { rerank: async () => [{ index: 1, score: 2 }, { index: 0, score: 1 }] };

    const out = await orchestrator.retrieve(input('code'), config(true, true, false));

    assert.deepEqual(out.slice(0, 2).map((item: Neighbor) => item.filePath), ['second.ts', 'first.ts']);
});

test('FimRetrievalOrchestrator fails open to merged order when rerank throws', async () => {
    const orchestrator = new FimRetrievalOrchestrator([
        channel('semantic', false, true, [neighbor('first.ts')]),
        channel('graph', true, true, [neighbor('second.ts')]),
    ]);
    const patched = orchestrator as unknown as { reranker: { rerank: () => Promise<never> } };
    patched.reranker = { rerank: async () => { throw new Error('boom'); } };

    const out = await orchestrator.retrieve(input('code'), config(true, true, false));

    assert.deepEqual(out.slice(0, 2).map((item: Neighbor) => item.filePath), ['first.ts', 'second.ts']);
});
