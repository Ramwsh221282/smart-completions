import type { EmbeddingConfig } from '../../src/common/embedding-types';
import { FimEmbeddingIndexService } from '../../src/node/fim-module/embedding/fim-embedding-index-service';
import { resetFimLanceDb } from './fim-lancedb-reset';

const GRANITE_FIM_EMBEDDER_ID = 'qwen3-0.6b';

export interface ResetGraniteLanceDbInput {
    storageDir: string;
    roots: string[];
    config: EmbeddingConfig;
    previousService?: FimEmbeddingIndexService;
}

export function resetGraniteLanceDb(input: ResetGraniteLanceDbInput): Promise<FimEmbeddingIndexService> {
    return resetFimLanceDb({
        storageDir: input.storageDir,
        roots: input.roots,
        config: input.config,
        embedderId: GRANITE_FIM_EMBEDDER_ID,
        previousService: input.previousService,
    });
}
