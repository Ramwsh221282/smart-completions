import { injectable } from '@theia/core/shared/inversify';
import type { Neighbor } from '../../../../common/embedding-types';
import type { SweepRetrievalConfig } from '../sweep-retrieval-orchestrator';
import { SweepGraphChannel } from '../graph/sweep-graph-channel';
import type { RetrievalChannel, RetrievalChannelInput } from '../retrieval-channel';

/** Структурный канал оборачивает существующий SweepGraphChannel без изменения его API. */
@injectable()
export class GraphRetrievalChannel implements RetrievalChannel {
    readonly id = 'graph';
    readonly codeOnly = true;

    constructor(private readonly graph: SweepGraphChannel) {}

    isEnabled(config: SweepRetrievalConfig): boolean {
        return config.graph.enabled;
    }

    retrieve(input: RetrievalChannelInput, topN: number): Neighbor[] {
        return this.graph.retrieve(input.signals, topN);
    }
}
