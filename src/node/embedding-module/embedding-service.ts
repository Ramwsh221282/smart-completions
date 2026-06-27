import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    type EmbeddingConfig,
    type IndexProgress,
    type IndexStatus,
    type Neighbor,
    type ConnTarget,
    type TestResult,
} from '../../common/embedding-types';
import { Chunker } from './chunker/chunker';
import { Bm25Index } from './vector-store/bm25-index';
import type { VectorStore } from './vector-store/iface';
import { LanceVectorStore } from './vector-store/lancedb-store';
import { ChromaVectorStore } from './vector-store/chromadb-store';
import type { EmbedClient } from './embed-client/llama-embed-client';
import { LlamaEmbedClient } from './embed-client/llama-embed-client';
import { HybridRetriever } from './retriever/hybrid-retriever';
import { RepoIndexer } from './indexer/repo-indexer';
import { IndexPersistence } from './indexer/persistence';
import { md5 } from '../util/hash';

// Псевдонимы коротких имён → полные имена для llama.cpp. Любое неизвестное имя
// уходит в запрос как есть, что снимает ограничение на набор embedding-моделей.
const EMBED_MODEL_ALIAS: Record<string, string> = {
    nomic: 'nomic-embed-text',
    granite: 'granite-embedding',
};

export function resolveEmbedModelName(embedModel: string): string {
    return EMBED_MODEL_ALIAS[embedModel] ?? embedModel;
}

export interface EmbeddingServiceDeps {
    /** Каталог хранилища (lancedb-файлы + index-meta.json). */
    storageDir: string;
    /** Фабрики для подмены в тестах. */
    createEmbedClient?: (config: EmbeddingConfig) => EmbedClient;
    createStore?: (config: EmbeddingConfig, storageDir: string) => VectorStore;
    /** Трансформ документа перед эмбеддингом нужен асимметричным моделям FIM retrieval. */
    transformDocumentText?: (text: string) => string;
}

export interface EmbeddingServiceCallbacks {
    onStatus?(status: IndexStatus): void;
    onProgress?(progress: IndexProgress): void;
}

/**
 * Ядро embedding-module: связывает store/bm25/embed/retriever/indexer по конфигу.
 * Чистый Node-класс (без @theia) — тестируется с дублёрами store/embed.
 */
export class EmbeddingService {
    private readonly chunker = new Chunker();
    private bm25 = new Bm25Index();
    private store: VectorStore | undefined;
    private embed: EmbedClient | undefined;
    private retriever: HybridRetriever | undefined;
    private indexer: RepoIndexer | undefined;
    private status: IndexStatus = { state: 'idle', filesIndexed: 0, totalFiles: 0 };

    constructor(
        private readonly deps: EmbeddingServiceDeps,
        private readonly callbacks: EmbeddingServiceCallbacks = {},
    ) {}

    /** Применить конфиг и (пере)собрать пайплайн. roots — fs-пути корней воркспейса. */
    async configure(config: EmbeddingConfig, roots: string[]): Promise<void> {
        const workspaceDir = this.workspaceDir(roots);
        const embed = this.createEmbedClient(config);
        const store = this.createStore(config, workspaceDir);
        this.embed = embed;
        this.store = store;
        this.bm25 = new Bm25Index();
        this.retriever = this.createRetriever(store, embed);
        this.indexer = this.createIndexer(config, roots, workspaceDir, store, embed);
    }

    /** Фоновый старт: восстановление с диска + reconcile (или полный rebuild). */
    async start(signal?: AbortSignal): Promise<void> {
        await this.indexer?.reconcile(signal);
    }

    async rebuild(signal?: AbortSignal): Promise<void> {
        await this.indexer?.rebuild(signal);
    }

    async reindexFile(uri: string, signal?: AbortSignal): Promise<void> {
        await this.indexer?.reindexFile(uriToFsPath(uri), signal);
    }

    getStatus(): IndexStatus {
        return this.status;
    }

    /** Гибридный retrieval для FIM/NES. queryText = хвост префикса. */
    async retrieve(queryText: string, topN: number, signal?: AbortSignal, vectorQueryText?: string): Promise<Neighbor[]> {
        if (!this.retriever) {
            return [];
        }
        return this.retriever.retrieve({ queryText, vectorQueryText, topN, signal });
    }

    async testConnection(target: ConnTarget): Promise<TestResult> {
        const t0 = Date.now();
        try {
            if (target.kind === 'embedding' && this.embed) {
                await this.embed.embed(['ping']);
                return { ok: true, latencyMs: Date.now() - t0 };
            }
            const res = await fetch(target.url, { method: 'GET' });
            return { ok: res.status < 500, detail: `HTTP ${res.status}`, latencyMs: Date.now() - t0 };
        } catch (e) {
            return { ok: false, detail: e instanceof Error ? e.message : String(e) };
        }
    }

    async dispose(): Promise<void> {
        await this.store?.dispose();
    }

    private workspaceDir(roots: string[]): string {
        // Изоляция хранилища по воркспейсу (детерминированный подкаталог по корням).
        return path.join(this.deps.storageDir, md5(roots.join('|') || 'default'));
    }

    private createEmbedClient(config: EmbeddingConfig): EmbedClient {
        return (this.deps.createEmbedClient ?? defaultCreateEmbedClient)(config);
    }

    private createStore(config: EmbeddingConfig, workspaceDir: string): VectorStore {
        return (this.deps.createStore ?? defaultCreateStore)(config, workspaceDir);
    }

    private createRetriever(store: VectorStore, embed: EmbedClient): HybridRetriever {
        return new HybridRetriever(store, this.bm25, embed);
    }

    private createIndexer(
        config: EmbeddingConfig,
        roots: string[],
        workspaceDir: string,
        store: VectorStore,
        embed: EmbedClient,
    ): RepoIndexer {
        return new RepoIndexer(
            roots,
            {
                chunker: this.chunker,
                embed,
                store,
                bm25: this.bm25,
                transformDocumentText: this.deps.transformDocumentText,
            },
            new IndexPersistence(path.join(workspaceDir, 'index-meta.json')),
            config.embedModel,
            this.indexerCallbacks(),
        );
    }

    private indexerCallbacks(): EmbeddingServiceCallbacks {
        return {
            onStatus: status => {
                this.status = status;
                this.callbacks.onStatus?.(status);
            },
            onProgress: progress => this.callbacks.onProgress?.(progress),
        };
    }
}

function uriToFsPath(uri: string): string {
    try {
        return uri.startsWith('file:') ? fileURLToPath(uri) : uri;
    } catch {
        return uri;
    }
}

function defaultCreateEmbedClient(config: EmbeddingConfig): EmbedClient {
    return new LlamaEmbedClient({
        baseUrl: config.llamaUrl,
        model: resolveEmbedModelName(config.embedModel),
    });
}

function defaultCreateStore(config: EmbeddingConfig, storageDir: string): VectorStore {
    if (config.vectorDb === 'chromadb') {
        return new ChromaVectorStore(config.chromaUrl ?? 'http://127.0.0.1:8000');
    }
    return new LanceVectorStore(path.join(storageDir, 'lancedb'));
}
