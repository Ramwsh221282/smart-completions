import type { Neighbor } from '../../../common/embedding-types';
import type { GraphQuerySignals } from '../../../common/sweep/types';
import type { SweepRetrievalConfig } from './sweep-retrieval-orchestrator';

// Единый вход retrieval-каналов позволяет оркестратору обходить их как композит без знания внутренних сигнатур.
export interface RetrievalChannelInput {
    query: string;
    signals: GraphQuerySignals;
    fuzzySymbols: string[];
    signal?: AbortSignal;
}

/** Канал retrieval; собирается в композит SweepRetrievalOrchestrator. */
export interface RetrievalChannel {
    readonly id: string;
    readonly codeOnly: boolean;
    isEnabled(config: SweepRetrievalConfig): boolean;
    retrieve(input: RetrievalChannelInput, topN: number): Promise<Neighbor[]> | Neighbor[];
}

/** DI-токен @multiInject; порядок биндингов определяет tie-break при равном RRF score. */
export const RetrievalChannel = Symbol('RetrievalChannel');
