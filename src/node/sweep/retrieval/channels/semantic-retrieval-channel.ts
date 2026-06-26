import { injectable } from '@theia/core/shared/inversify';
import type { Neighbor } from '../../../../common/embedding-types';
import { SweepLogger } from '../../../../common/sweep/logger';
import { EmbeddingIndexServiceImpl } from '../../../services/embedding-index-service';
import type { RetrievalChannel, RetrievalChannelInput } from '../retrieval-channel';
import type { SweepRetrievalConfig } from '../sweep-retrieval-orchestrator';

const LOG = new SweepLogger('node:retrieval-orchestrator');

/** Семантический канал идёт через общий EmbeddingIndexServiceImpl, не меняя его контракт и тесты. */
@injectable()
export class SemanticRetrievalChannel implements RetrievalChannel {
    readonly id = 'semantic';
    readonly codeOnly = false;

    constructor(private readonly embedding: EmbeddingIndexServiceImpl) {}

    isEnabled(_config: SweepRetrievalConfig): boolean {
        return true;
    }

    async retrieve(input: RetrievalChannelInput, topN: number): Promise<Neighbor[]> {
        LOG.info('Sweep semantic retrieval starting', { queryChars: input.query.length, topN });
        const neighbors = await this.embedding.retrieve(input.query, topN, input.signal);
        const files = new Array<string>(neighbors.length);
        for (let i = 0; i < neighbors.length; i++) {
            files[i] = neighbors[i].filePath;
        }
        LOG.info('Sweep semantic retrieval completed', { neighbors: neighbors.length, files });
        return neighbors;
    }
}
