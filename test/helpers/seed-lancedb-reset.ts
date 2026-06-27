import type { EmbeddingConfig } from '../../src/common/embedding-types';
import { FimEmbeddingIndexService } from '../../src/node/fim-module/embedding/fim-embedding-index-service';
import { resetFimLanceDb } from './fim-lancedb-reset';

const SEED_FIM_EMBEDDER_ID = 'qwen3-0.6b';

export interface ResetSeedLanceDbInput {
    storageDir: string;
    roots: string[];
    config: EmbeddingConfig;
    previousService?: FimEmbeddingIndexService;
}

export function resetSeedLanceDb(input: ResetSeedLanceDbInput): Promise<FimEmbeddingIndexService> {
    return resetFimLanceDb({
        storageDir: input.storageDir,
        roots: input.roots,
        config: input.config,
        embedderId: SEED_FIM_EMBEDDER_ID,
        previousService: input.previousService,
    });
}
