import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { injectable } from '@theia/core/shared/inversify';
import { EmbeddingIndexService, EmbeddingIndexClient } from '../../common/protocol';
import {
    EmbeddingConfig,
    IndexStatus,
    ConnTarget,
    TestResult,
    Neighbor,
} from '../../common/embedding-types';
import { EmbeddingService } from '../embedding-module/embedding-service';

/**
 * Backend-реализация RPC-сервиса embedding-индекса поверх чистого EmbeddingService.
 * Также служит общей точкой retrieval для FIM/NES (метод retrieve, не по RPC).
 */
@injectable()
export class EmbeddingIndexServiceImpl implements EmbeddingIndexService {
    private client: EmbeddingIndexClient | undefined;
    private roots: string[] = [];
    private retrievalOptions = { topN: 4, prefixTailChars: 400 };
    private readonly service: EmbeddingService;

    constructor() {
        const storageDir = path.join(os.homedir(), '.theia', 'smart-completions', 'embedding');
        this.service = new EmbeddingService(
            { storageDir },
            {
                onStatus: status => this.client?.onStatusChanged(status),
                onProgress: progress => this.client?.onIndexProgress(progress),
            },
        );
    }

    setClient(client: EmbeddingIndexClient | undefined): void {
        this.client = client;
    }

    getClient(): EmbeddingIndexClient | undefined {
        return this.client;
    }

    async configure(config: EmbeddingConfig, workspaceRoots: string[]): Promise<void> {
        // Корни приходят как file:-URI с frontend → конвертируем в fs-пути.
        const fsRoots = workspaceRoots.map(r => {
            try {
                return r.startsWith('file:') ? fileURLToPath(r) : r;
            } catch {
                return r;
            }
        });
        this.roots = fsRoots;
        this.retrievalOptions = { topN: config.topN, prefixTailChars: config.prefixTailChars };
        await this.service.configure(config, fsRoots);
        if (config.indexOnOpen) {
            // фоновый старт (reconcile/rebuild) — не блокируем RPC-вызов
            void this.service.start().catch(() => undefined);
        }
    }

    async rebuild(): Promise<void> {
        await this.service.rebuild();
    }

    async reindexFile(uri: string): Promise<void> {
        await this.service.reindexFile(uri);
    }

    async getStatus(): Promise<IndexStatus> {
        return this.service.getStatus();
    }

    async testConnection(target: ConnTarget): Promise<TestResult> {
        return this.service.testConnection(target);
    }

    /** Не по RPC: используется FIM/NES backend-сервисами для контекста. */
    async retrieve(queryText: string, topN: number, signal?: AbortSignal): Promise<Neighbor[]> {
        return this.service.retrieve(queryText, topN, signal);
    }

    get workspaceRoots(): string[] {
        return this.roots;
    }

    getRetrievalOptions(): { topN: number; prefixTailChars: number } {
        return this.retrievalOptions;
    }

    dispose(): void {
        void this.service.dispose().catch(() => undefined);
    }
}
