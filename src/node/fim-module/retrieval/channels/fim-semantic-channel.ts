import { inject, injectable } from '@theia/core/shared/inversify';
import type { Neighbor } from '../../../../common/embedding-types';
import { FimLogger } from '../../../../common/fim/logger';
import type { FimRetrievalConfig } from '../../../../common/fim-types';
import { FimEmbeddingIndexService } from '../../embedding/fim-embedding-index-service';
import type { RetrievalChannel, RetrievalChannelInput } from '../fim-retrieval-channel';

const LOG = new FimLogger('node:retrieval-orchestrator');

@injectable()
export class FimSemanticRetrievalChannel implements RetrievalChannel {
    readonly id = 'semantic';
    readonly codeOnly = false;

    @inject(FimEmbeddingIndexService) private readonly embedding!: FimEmbeddingIndexService;

    isEnabled(_config: FimRetrievalConfig): boolean {
        return true;
    }

    async retrieve(input: RetrievalChannelInput, topN: number): Promise<Neighbor[]> {
        LOG.info('FIM semantic retrieval starting', { queryChars: input.query.length, topN });
        const neighbors = await this.embedding.retrieve(input.query, topN, input.signal);
        LOG.info('FIM semantic retrieval completed', { neighbors: neighbors.length });
        return neighbors;
    }
}
