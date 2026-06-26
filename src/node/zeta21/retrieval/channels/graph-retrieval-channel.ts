import { injectable } from '@theia/core/shared/inversify';
import type { Neighbor } from '../../../../common/embedding-types';
import { SweepGraphChannel } from '../../../sweep/retrieval/graph/sweep-graph-channel';
import type { RetrievalChannel, RetrievalChannelInput } from '../retrieval-channel';
import type { ZetaRetrievalConfig } from '../zeta-retrieval-orchestrator';

/** Структурный канал zeta21 оборачивает общий SweepGraphChannel без изменения его API и индекса. */
@injectable()
export class ZetaGraphRetrievalChannel implements RetrievalChannel {
    readonly id = 'graph';
    readonly codeOnly = true;

    constructor(private readonly graph: SweepGraphChannel) {}

    isEnabled(config: ZetaRetrievalConfig): boolean {
        return config.graph.enabled;
    }

    retrieve(input: RetrievalChannelInput, topN: number): Neighbor[] {
        return this.graph.retrieve(input.signals, topN);
    }
}
