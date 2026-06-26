import type { GraphQuerySignals } from '../../../common/sweep/types';
import type { Neighbor } from '../../../common/embedding-types';
import type { FimRetrievalConfig } from '../../../common/fim-types';

export interface RetrievalChannelInput {
    query: string;
    signals: GraphQuerySignals;
    fuzzySymbols: string[];
    signal?: AbortSignal;
}

export interface RetrievalChannel {
    readonly id: string;
    readonly codeOnly: boolean;
    isEnabled(config: FimRetrievalConfig): boolean;
    retrieve(input: RetrievalChannelInput, topN: number): Promise<Neighbor[]> | Neighbor[];
}

export const FimRetrievalChannel = Symbol('FimRetrievalChannel');
