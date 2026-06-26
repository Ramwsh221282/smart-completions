import { injectable } from '@theia/core/shared/inversify';
import type { Neighbor } from '../../../../common/embedding-types';
import type { FimRetrievalConfig } from '../../../../common/fim-types';
import { SweepGraphChannel } from '../../../sweep/retrieval/graph/sweep-graph-channel';
import type { RetrievalChannel, RetrievalChannelInput } from '../fim-retrieval-channel';

@injectable()
export class FimGraphRetrievalChannel implements RetrievalChannel {
    readonly id = 'graph';
    readonly codeOnly = true;

    constructor(private readonly graph: SweepGraphChannel) {}

    isEnabled(config: FimRetrievalConfig): boolean {
        return config.graph.enabled;
    }

    retrieve(input: RetrievalChannelInput, topN: number): Neighbor[] {
        return this.graph.retrieve(input.signals, topN);
    }
}
