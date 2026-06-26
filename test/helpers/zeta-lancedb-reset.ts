import * as fs from 'node:fs';
import { EmbeddingService } from '../../src/node/embedding-module/embedding-service';
import type { EmbeddingConfig } from '../../src/common/embedding-types';

// Вход reset helper держит только то, что действительно нужно для чистого перезапуска embedded LanceDB и повторной индексации.
export interface ResetZetaLanceDbInput {
    storageDir: string;
    roots: string[];
    config: EmbeddingConfig;
    previousService?: EmbeddingService;
}

/** Полностью сбрасывает embedded LanceDB состояние и пересоздаёт EmbeddingService так, чтобы следующий тест стартовал на чистом индексе. */
export async function resetZetaLanceDb(input: ResetZetaLanceDbInput): Promise<EmbeddingService> {
    await input.previousService?.dispose();
    fs.rmSync(input.storageDir, { recursive: true, force: true });
    fs.mkdirSync(input.storageDir, { recursive: true });
    const service = new EmbeddingService({ storageDir: input.storageDir });
    await service.configure(input.config, input.roots);
    await service.rebuild();
    return service;
}
