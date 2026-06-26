import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Neighbor } from '../src/common/embedding-types';
import { DEFAULT_SWEEP_FUZZY_CONFIG, DEFAULT_SWEEP_GRAPH_CONFIG, DEFAULT_SWEEP_RERANK_CONFIG, GraphQuerySignals } from '../src/common/sweep/types';
import type { RetrievalChannel } from '../src/node/sweep/retrieval/retrieval-channel';
import { SweepRetrievalOrchestrator } from '../src/node/sweep/retrieval/sweep-retrieval-orchestrator';

/** Stub retrieval channel сохраняет число вызовов и даёт оркестратору deterministic output. */
class ChannelStub implements RetrievalChannel {
    calls = 0;
    readonly id: string;
    readonly codeOnly: boolean;
    private readonly enabled: boolean;

    /** Возвращает configured neighbors для проверки orchestration без внешних сервисов. */
    constructor(id: string, codeOnly: boolean, enabled: boolean, private readonly neighbors: Neighbor[]) {
        this.id = id;
        this.codeOnly = codeOnly;
        this.enabled = enabled;
    }

    /** Сохраняет старый deterministic stub-поток, но через новый RetrievalChannel API. */
    retrieve(): Neighbor[] {
        this.calls++;
        return this.neighbors;
    }

    isEnabled(): boolean {
        return this.enabled;
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
    const semantic = new ChannelStub('semantic', false, true, [neighbor('semantic.ts')]);
    const graph = new ChannelStub('graph', true, true, [neighbor('graph.ts')]);
    const fuzzy = new ChannelStub('fuzzy', true, true, [neighbor('fuzzy.ts')]);
    const orchestrator = new SweepRetrievalOrchestrator([semantic, graph, fuzzy]);
    const config = { rerank: { ...DEFAULT_SWEEP_RERANK_CONFIG, enabled: false, finalTopN: 5 }, graph: DEFAULT_SWEEP_GRAPH_CONFIG, fuzzy: DEFAULT_SWEEP_FUZZY_CONFIG };

    const prose = await orchestrator.retrieve({ query: 'q', fileMode: 'prose', signals: signals(), fuzzySymbols: ['getUserName'], topN: 5 }, config);
    assert.deepEqual(prose.map(item => item.filePath), ['semantic.ts']);
    assert.equal(semantic.calls, 1);
    assert.equal(graph.calls, 0);
    assert.equal(fuzzy.calls, 0);

    const code = await orchestrator.retrieve({ query: 'q', fileMode: 'code', signals: signals(), fuzzySymbols: ['getUserName'], topN: 5 }, config);
    assert.ok(code.some(item => item.filePath === 'graph.ts'));
    assert.ok(code.some(item => item.filePath === 'fuzzy.ts'));
    assert.equal(semantic.calls, 2);
    assert.equal(graph.calls, 1);
    assert.equal(fuzzy.calls, 1);
});
