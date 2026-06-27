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

function config(rerankEnabled = true): FimRetrievalConfig {
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
        graph: { enabled: true },
        fuzzy: { enabled: true },
    };
}

function input() {
    return {
        query: 'renderSeedPrompt verifySeedSpecialTokens',
        fileMode: 'code' as const,
        signals: { cursorSymbol: 'renderSeedPrompt', renamedSymbols: ['verifySeedSpecialTokens'], diagnosticSymbols: [], importedSymbols: ['renderSeedPrompt'] },
        fuzzySymbols: ['renderSeedPrompt', 'verifySeedSpecialTokens'],
        topN: 10,
    };
}

test('seed composite retrieval reranks merged candidates with the shared FIM orchestrator', async () => {
    const orchestrator = new FimRetrievalOrchestrator([
        channel('semantic', false, true, [neighbor('semantic.ts')]),
        channel('graph', true, true, [neighbor('graph.ts')]),
        channel('fuzzy', true, true, [neighbor('fuzzy.ts')]),
    ]);
    const patched = orchestrator as unknown as { reranker: { rerank: () => Promise<Array<{ index: number; score: number }>> } };
    patched.reranker = { rerank: async () => [{ index: 2, score: 3 }, { index: 0, score: 2 }, { index: 1, score: 1 }] };

    const out = await orchestrator.retrieve(input(), config());

    assert.deepEqual(out.slice(0, 3).map(item => item.filePath), ['fuzzy.ts', 'semantic.ts', 'graph.ts']);
});

test('seed composite retrieval fails open to merged order when rerank throws', async () => {
    const orchestrator = new FimRetrievalOrchestrator([
        channel('semantic', false, true, [neighbor('semantic.ts')]),
        channel('graph', true, true, [neighbor('graph.ts')]),
    ]);
    const patched = orchestrator as unknown as { reranker: { rerank: () => Promise<never> } };
    patched.reranker = { rerank: async () => { throw new Error('boom'); } };

    const out = await orchestrator.retrieve(input(), config());

    assert.deepEqual(out.slice(0, 2).map(item => item.filePath), ['semantic.ts', 'graph.ts']);
});
