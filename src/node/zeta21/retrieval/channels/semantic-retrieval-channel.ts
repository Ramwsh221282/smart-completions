import { injectable } from '@theia/core/shared/inversify';
import type { Neighbor } from '../../../../common/embedding-types';
import { ZetaLogger } from '../../../../common/zeta21/logger';
import { EmbeddingIndexServiceImpl } from '../../../services/embedding-index-service';
import type { RetrievalChannel, RetrievalChannelInput } from '../retrieval-channel';
import type { ZetaRetrievalConfig } from '../zeta-retrieval-orchestrator';

const LOG = new ZetaLogger('node:retrieval-orchestrator');

/** Семантический канал идёт через общий EmbeddingIndexServiceImpl, не меняя его контракт и тесты. */
@injectable()
export class ZetaSemanticRetrievalChannel implements RetrievalChannel {
    readonly id = 'semantic';
    readonly codeOnly = false;

    constructor(private readonly embedding: EmbeddingIndexServiceImpl) {}

    isEnabled(_config: ZetaRetrievalConfig): boolean {
        return true;
    }

    async retrieve(input: RetrievalChannelInput, topN: number): Promise<Neighbor[]> {
        LOG.info('Zeta semantic retrieval starting', { queryChars: input.query.length, topN });
        const neighbors = await this.embedding.retrieve(input.query, topN, input.signal);
        const files = new Array<string>(neighbors.length);
        for (let i = 0; i < neighbors.length; i++) {
            files[i] = neighbors[i].filePath;
        }
        LOG.info('Zeta semantic retrieval completed', { neighbors: neighbors.length, files });
        return neighbors;
    }
}
