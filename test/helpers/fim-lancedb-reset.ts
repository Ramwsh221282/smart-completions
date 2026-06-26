import * as fs from 'node:fs';
import type { EmbeddingConfig } from '../../src/common/embedding-types';
import { FimEmbeddingIndexService } from '../../src/node/fim-module/embedding/fim-embedding-index-service';

export interface ResetFimLanceDbInput {
    storageDir: string;
    roots: string[];
    config: EmbeddingConfig;
    embedderId: string;
    previousService?: FimEmbeddingIndexService;
}

export async function resetFimLanceDb(input: ResetFimLanceDbInput): Promise<FimEmbeddingIndexService> {
    await input.previousService?.dispose();
    fs.rmSync(input.storageDir, { recursive: true, force: true });
    fs.mkdirSync(input.storageDir, { recursive: true });
    process.env.SC_FIM_STORAGE_DIR = input.storageDir;
    const service = new FimEmbeddingIndexService();
    await service.configure(input.config, input.roots, input.embedderId);
    await service.rebuild();
    return service;
}
