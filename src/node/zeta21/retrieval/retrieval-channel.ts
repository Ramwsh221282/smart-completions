import type { Neighbor } from '../../../common/embedding-types';
import type { GraphQuerySignals } from '../../../common/sweep/types';
import type { ZetaRetrievalConfig } from './zeta-retrieval-orchestrator';

// Единый вход retrieval-каналов позволяет zeta21 оркестратору обходить их как композит без знания частных сигнатур.
export interface RetrievalChannelInput {
    query: string;
    signals: GraphQuerySignals;
    fuzzySymbols: string[];
    signal?: AbortSignal;
}

/** Канал retrieval; собирается в композит ZetaRetrievalOrchestrator. */
export interface RetrievalChannel {
    readonly id: string;
    readonly codeOnly: boolean;
    isEnabled(config: ZetaRetrievalConfig): boolean;
    retrieve(input: RetrievalChannelInput, topN: number): Promise<Neighbor[]> | Neighbor[];
}

/** DI-токен @multiInject; порядок биндингов определяет tie-break при равном RRF score. */
export const ZetaRetrievalChannel = Symbol('ZetaRetrievalChannel');
