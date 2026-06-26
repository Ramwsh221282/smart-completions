import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Neighbor } from '../src/common/embedding-types';
import { DEFAULT_SWEEP_RERANK_CONFIG } from '../src/common/sweep/types';
import type { RetrievalChannel } from '../src/node/sweep/retrieval/retrieval-channel';
import { SweepRetrievalOrchestrator, type SweepRetrievalConfig } from '../src/node/sweep/retrieval/sweep-retrieval-orchestrator';

function neighbor(filePath: string, score = 1): Neighbor {
    return { filePath, startLine: 1, endLine: 2, text: filePath, score };
}

function channel(id: string, codeOnly: boolean, enabled: boolean, out: Neighbor[]): RetrievalChannel {
    return { id, codeOnly, isEnabled: () => enabled, retrieve: () => out };
}

function config(graphEnabled = true, fuzzyEnabled = true): SweepRetrievalConfig {
    return {
        rerank: { ...DEFAULT_SWEEP_RERANK_CONFIG, enabled: false, finalTopN: 10, candidatePoolN: 10 },
        graph: { enabled: graphEnabled },
        fuzzy: { enabled: fuzzyEnabled },
    };
}

function input(fileMode: 'code' | 'prose') {
    return { query: 'q', fileMode, signals: { cursorSymbol: 's', renamedSymbols: [], diagnosticSymbols: [], importedSymbols: [] }, fuzzySymbols: ['s'], topN: 10 };
}

test('SweepRetrievalOrchestrator includes channels in registration order for code mode', async () => {
    const orchestrator = new SweepRetrievalOrchestrator([
        channel('semantic', false, true, [neighbor('s.ts')]),
        channel('graph', true, true, [neighbor('g.ts')]),
        channel('fuzzy', true, true, [neighbor('f.ts')]),
    ]);

    const out = await orchestrator.retrieve(input('code'), config());

    assert.deepEqual(out.map(item => item.filePath), ['s.ts', 'g.ts', 'f.ts']);
});

test('SweepRetrievalOrchestrator runs only non-code-only channels for prose mode', async () => {
    const orchestrator = new SweepRetrievalOrchestrator([
        channel('semantic', false, true, [neighbor('s.ts')]),
        channel('graph', true, true, [neighbor('g.ts')]),
        channel('fuzzy', true, true, [neighbor('f.ts')]),
    ]);

    const out = await orchestrator.retrieve(input('prose'), config());

    assert.deepEqual(out.map(item => item.filePath), ['s.ts']);
});

test('SweepRetrievalOrchestrator skips disabled channels', async () => {
    const orchestrator = new SweepRetrievalOrchestrator([
        channel('semantic', false, true, [neighbor('s.ts')]),
        channel('graph', true, false, [neighbor('g.ts')]),
        channel('fuzzy', true, true, [neighbor('f.ts')]),
    ]);

    const out = await orchestrator.retrieve(input('code'), config(false, true));

    assert.deepEqual(out.map(item => item.filePath), ['s.ts', 'f.ts']);
});

test('SweepRetrievalOrchestrator dedups equal neighbors from earlier channels first', async () => {
    const dup = neighbor('dup.ts');
    const orchestrator = new SweepRetrievalOrchestrator([
        channel('semantic', false, true, [dup]),
        channel('graph', true, true, [dup]),
    ]);

    const out = await orchestrator.retrieve(input('code'), config(true, false));

    assert.equal(out.length, 1);
    assert.equal(out[0].filePath, 'dup.ts');
});
