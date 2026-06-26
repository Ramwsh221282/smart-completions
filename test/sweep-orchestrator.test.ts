import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Neighbor } from '../src/common/embedding-types';
import { DEFAULT_SWEEP_FUZZY_CONFIG, DEFAULT_SWEEP_GRAPH_CONFIG, DEFAULT_SWEEP_RERANK_CONFIG, GraphQuerySignals } from '../src/common/sweep/types';
import type { EmbeddingIndexServiceImpl } from '../src/node/services/embedding-index-service';
import type { SweepFuzzyChannel } from '../src/node/sweep/retrieval/fuzzy/sweep-fuzzy-channel';
import type { SweepGraphChannel } from '../src/node/sweep/retrieval/graph/sweep-graph-channel';
import { SweepRetrievalOrchestrator } from '../src/node/sweep/retrieval/sweep-retrieval-orchestrator';

/** Stub channel сохраняет число вызовов и отдаёт заранее заданные neighbors. */
class ChannelStub {
    calls = 0;

    /** Возвращает configured neighbors для проверки orchestration без внешних сервисов. */
    constructor(private readonly neighbors: Neighbor[]) {}

    /** Совместимая сигнатура retrieve для graph/fuzzy stubs. */
    retrieve(): Neighbor[] {
        this.calls++;
        return this.neighbors;
    }
}

/** Stub embedding channel имитирует semantic S retrieval без llama.cpp. */
class EmbeddingStub {
    calls = 0;

    /** Возвращает semantic neighbors async, как реальный EmbeddingIndexServiceImpl. */
    constructor(private readonly neighbors: Neighbor[]) {}

    /** Совместимая сигнатура retrieve для semantic channel. */
    async retrieve(): Promise<Neighbor[]> {
        this.calls++;
        return this.neighbors;
    }
}

/** Создаёт Neighbor для проверки channel merge порядка. */
function neighbor(filePath: string): Neighbor {
    return { filePath, startLine: 1, endLine: 2, text: filePath, score: 0 };
}

/** Создаёт минимальные graph signals для orchestrator input. */
function signals(): GraphQuerySignals {
    return { cursorSymbol: 'getUserName', renamedSymbols: [], diagnosticSymbols: [], importedSymbols: [] };
}

/** Проверяет code/prose gating: G/F code-only даже когда defaults true. */
test('SweepRetrievalOrchestrator runs graph fuzzy only for code mode', async () => {
    const embedding = new EmbeddingStub([neighbor('semantic.ts')]);
    const graph = new ChannelStub([neighbor('graph.ts')]);
    const fuzzy = new ChannelStub([neighbor('fuzzy.ts')]);
    const orchestrator = new SweepRetrievalOrchestrator(
        embedding as unknown as EmbeddingIndexServiceImpl,
        graph as unknown as SweepGraphChannel,
        fuzzy as unknown as SweepFuzzyChannel,
    );
    const config = { rerank: { ...DEFAULT_SWEEP_RERANK_CONFIG, enabled: false, finalTopN: 5 }, graph: DEFAULT_SWEEP_GRAPH_CONFIG, fuzzy: DEFAULT_SWEEP_FUZZY_CONFIG };

    const prose = await orchestrator.retrieve({ query: 'q', fileMode: 'prose', signals: signals(), fuzzySymbols: ['getUserName'], topN: 5 }, config);
    assert.deepEqual(prose.map(item => item.filePath), ['semantic.ts']);
    assert.equal(graph.calls, 0);
    assert.equal(fuzzy.calls, 0);

    const code = await orchestrator.retrieve({ query: 'q', fileMode: 'code', signals: signals(), fuzzySymbols: ['getUserName'], topN: 5 }, config);
    assert.ok(code.some(item => item.filePath === 'graph.ts'));
    assert.ok(code.some(item => item.filePath === 'fuzzy.ts'));
    assert.equal(graph.calls, 1);
    assert.equal(fuzzy.calls, 1);
});
