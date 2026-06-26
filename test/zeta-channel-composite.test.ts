import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Neighbor } from '../src/common/embedding-types';
import { DEFAULT_SWEEP_RERANK_CONFIG } from '../src/common/sweep/types';
import type { RetrievalChannel } from '../src/node/zeta21/retrieval/retrieval-channel';
import { ZetaRetrievalOrchestrator, type ZetaRetrievalConfig } from '../src/node/zeta21/retrieval/zeta-retrieval-orchestrator';

function neighbor(filePath: string, score = 1): Neighbor {
    return { filePath, startLine: 1, endLine: 2, text: filePath, score };
}

function channel(id: string, codeOnly: boolean, enabled: boolean, out: Neighbor[]): RetrievalChannel {
    return { id, codeOnly, isEnabled: () => enabled, retrieve: () => out };
}

function config(graphEnabled = true, fuzzyEnabled = true): ZetaRetrievalConfig {
    return {
        rerank: { ...DEFAULT_SWEEP_RERANK_CONFIG, enabled: false, finalTopN: 10, candidatePoolN: 10 },
        graph: { enabled: graphEnabled },
        fuzzy: { enabled: fuzzyEnabled },
    };
}

function input(fileMode: 'code' | 'prose') {
    return { query: 'q', fileMode, signals: { cursorSymbol: 's', renamedSymbols: [], diagnosticSymbols: [], importedSymbols: [] }, fuzzySymbols: ['s'], topN: 10 };
}

test('ZetaRetrievalOrchestrator includes channels in registration order for code mode', async () => {
    const orchestrator = new ZetaRetrievalOrchestrator([
        channel('semantic', false, true, [neighbor('s.ts')]),
        channel('graph', true, true, [neighbor('g.ts')]),
        channel('fuzzy', true, true, [neighbor('f.ts')]),
    ]);

    const out = await orchestrator.retrieve(input('code'), config());

    assert.deepEqual(out.map(item => item.filePath), ['s.ts', 'g.ts', 'f.ts']);
});

test('ZetaRetrievalOrchestrator runs only non-code-only channels for prose mode and skips disabled channels', async () => {
    const orchestrator = new ZetaRetrievalOrchestrator([
        channel('semantic', false, true, [neighbor('s.ts')]),
        channel('graph', true, false, [neighbor('g.ts')]),
        channel('fuzzy', true, true, [neighbor('f.ts')]),
    ]);

    const prose = await orchestrator.retrieve(input('prose'), config(false, true));
    const code = await orchestrator.retrieve(input('code'), config(false, true));

    assert.deepEqual(prose.map(item => item.filePath), ['s.ts']);
    assert.deepEqual(code.map(item => item.filePath), ['s.ts', 'f.ts']);
});
