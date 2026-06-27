import * as os from 'node:os';
import * as path from 'node:path';
import { injectable } from '@theia/core/shared/inversify';
import type { EmbeddingConfig, Neighbor } from '../../../common/embedding-types';
import { applyMatryoshka, buildDocumentInput, buildQueryInput } from '../../../common/fim/fim-embedder';
import { DEFAULT_FIM_EMBEDDER_ID, getFimEmbedderProfile } from '../../../common/fim/fim-embedder-registry';
import { FimLogger } from '../../../common/fim/logger';
import { EmbeddingService } from '../../embedding-module/embedding-service';
import type { EmbedClient } from '../../embedding-module/embed-client/llama-embed-client';
import { LlamaEmbedClient } from '../../embedding-module/embed-client/llama-embed-client';

const LOG = new FimLogger('node:fim-embedding-index');

@injectable()
export class FimEmbeddingIndexService {
    private embedderId = DEFAULT_FIM_EMBEDDER_ID;
    private roots: string[] = [];
    private retrievalOptions = { topN: 4, prefixTailChars: 400 };
    private service: EmbeddingService | undefined;
    private serviceStorageKey = '';

    async configure(config: EmbeddingConfig, workspaceRoots: string[], embedderId: string): Promise<void> {
        this.embedderId = embedderId || DEFAULT_FIM_EMBEDDER_ID;
        this.roots = workspaceRoots;
        this.retrievalOptions = { topN: config.topN, prefixTailChars: config.prefixTailChars };
        await this.resetServiceIfNeeded();
        await this.service?.configure(this.embeddingConfig(config), workspaceRoots);
        if (config.indexOnOpen) {
            void this.service?.start().catch(error => {
                LOG.warn('FIM embedding index start failed', { error: error instanceof Error ? error.message : String(error) });
            });
        }
    }

    async rebuild(): Promise<void> {
        await this.service?.rebuild();
    }

    async reindexFile(uri: string, signal?: AbortSignal): Promise<void> {
        await this.service?.reindexFile(uri, signal);
    }

    async retrieve(queryText: string, topN: number, signal?: AbortSignal): Promise<Neighbor[]> {
        const profile = this.profile();
        // Асимметричные FIM-эмбеддеры кодируют query отдельно от documents, поэтому vector branch получает уже профилированный query input.
        return this.service?.retrieve(queryText, topN, signal, buildQueryInput(profile, queryText)) ?? [];
    }

    getRetrievalOptions(): { topN: number; prefixTailChars: number } {
        return this.retrievalOptions;
    }

    get workspaceRoots(): string[] {
        return this.roots;
    }

    async dispose(): Promise<void> {
        await this.service?.dispose();
    }

    private async resetServiceIfNeeded(): Promise<void> {
        const nextStorageKey = this.storageKey();
        if (this.service && this.serviceStorageKey === nextStorageKey) {
            return;
        }
        await this.service?.dispose();
        // FIM держит отдельный embedding-space по embedder profile, потому что query/document transforms и dimensionality могут отличаться от общего repo индекса.
        this.service = new EmbeddingService({
            storageDir: resolveFimEmbeddingStorageDir(this.embedderId),
            createEmbedClient: config => this.createEmbedClient(config),
            transformDocumentText: text => buildDocumentInput(this.profile(), text),
        });
        this.serviceStorageKey = nextStorageKey;
    }

    private createEmbedClient(config: EmbeddingConfig): EmbedClient {
        const profile = this.profile();
        return new FimProfiledEmbedClient(config.llamaUrl, profile.llamaModel, profile);
    }

    private embeddingConfig(config: EmbeddingConfig): EmbeddingConfig {
        return { ...config, embedModel: this.profile().llamaModel };
    }

    private profile() {
        return getFimEmbedderProfile(this.embedderId);
    }

    private storageKey(): string {
        return `${resolveFimEmbeddingStorageDir(this.embedderId)}::${this.embedderId}`;
    }
}

class FimProfiledEmbedClient implements EmbedClient {
    private readonly client: LlamaEmbedClient;

    constructor(baseUrl: string, model: string, private readonly embedderProfile: ReturnType<typeof getFimEmbedderProfile>) {
        this.client = new LlamaEmbedClient({ baseUrl, model });
    }

    async embed(inputs: string[], signal?: AbortSignal): Promise<number[][]> {
        const vectors = await this.client.embed(inputs, signal);
        if (this.embedderProfile.matryoshkaDim === null) {
            return vectors;
        }
        const out = new Array<number[]>(vectors.length);
        for (let i = 0; i < vectors.length; i++) {
            out[i] = projectVector(this.embedderProfile, vectors[i]);
        }
        return out;
    }
}

function resolveFimEmbeddingStorageDir(embedderId: string): string {
    const root = process.env.SC_FIM_STORAGE_DIR
        ?? path.join(os.homedir(), '.theia', 'smart-completions', 'fim-embedding');
    return path.join(root, embedderId);
}

function projectVector(embedderProfile: ReturnType<typeof getFimEmbedderProfile>, vector: number[]): number[] {
    return Array.from(applyMatryoshka(embedderProfile, Float32Array.from(vector)));
}
