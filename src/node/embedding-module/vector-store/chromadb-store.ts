import { ChromaClient } from 'chromadb';
import type { ChunkRecord, VectorHit, VectorStore } from './iface';

const COLLECTION = 'smart_completions_chunks';

interface ChromaMeta {
    file_path: string;
    start_line: number;
    end_line: number;
    language: string;
    node_type: string;
}

interface ChromaQueryResult {
    ids?: unknown[][];
    documents?: unknown[][];
    metadatas?: unknown[][];
    distances?: unknown[][];
}

interface ChromaGetResult {
    ids?: unknown[];
    documents?: unknown[];
    metadatas?: unknown[];
}

interface ChromaCollection {
    upsert(input: { ids: string[]; embeddings: number[][]; documents: string[]; metadatas: ChromaMeta[] }): Promise<void>;
    delete(input: { where: Record<string, unknown> }): Promise<void>;
    query(input: { queryEmbeddings: number[][]; nResults: number; include: string[] }): Promise<ChromaQueryResult>;
    get(input: { include: string[] }): Promise<ChromaGetResult>;
    count(): Promise<number>;
}

type CreateCollectionInput = Parameters<ChromaClient['getOrCreateCollection']>[0];

/**
 * ChromaDB-хранилище (сервер через pipx, HTTP). Векторы поставляем сами
 * (embeddingFunction: null). Лексическая половина гибрида — отдельный Bm25Index.
 */
export class ChromaVectorStore implements VectorStore {
    private client: ChromaClient | undefined;
    // На runtime нам нужен только небольшой поднабор методов коллекции, поэтому держим узкий structural interface.
    private collection: ChromaCollection | undefined;

    constructor(private readonly chromaUrl: string) {}

    async init(): Promise<void> {
        const u = new URL(this.chromaUrl);
        const ssl = u.protocol === 'https:';
        const port = u.port ? parseInt(u.port, 10) : ssl ? 443 : 80;
        this.client = new ChromaClient({ host: u.hostname, port, ssl });
        this.collection = await this.getOrCreate();
    }

    private async getOrCreate(): Promise<ChromaCollection> {
        // Явное cosine-пространство: дефолт Chroma — L2, на котором нулевые/короткие векторы
        // ложно оказываются ближе к запросу. Cosine совпадает с поведением LanceDB-стора.
        const input = {
            name: COLLECTION,
            embeddingFunction: null,
            configuration: { hnsw: { space: 'cosine' } },
        } as unknown as CreateCollectionInput;
        return (await this.clientOrThrow().getOrCreateCollection(input)) as unknown as ChromaCollection;
    }

    private ensure(): ChromaCollection {
        if (!this.collection) {
            throw new Error('ChromaVectorStore not initialized');
        }
        return this.collection;
    }

    private clientOrThrow(): ChromaClient {
        if (!this.client) {
            throw new Error('ChromaVectorStore client not initialized');
        }
        return this.client;
    }

    async upsert(records: ChunkRecord[]): Promise<void> {
        if (records.length === 0) {
            return;
        }
        const ids = new Array<string>(records.length);
        const embeddings = new Array<number[]>(records.length);
        const documents = new Array<string>(records.length);
        const metadatas = new Array<ChromaMeta>(records.length);
        for (let i = 0; i < records.length; i++) {
            const record = records[i];
            ids[i] = record.id;
            embeddings[i] = normalize(record.vector);
            documents[i] = record.text;
            metadatas[i] = {
                file_path: record.filePath,
                start_line: record.startLine,
                end_line: record.endLine,
                language: record.language,
                node_type: record.nodeType,
            };
        }
        await this.ensure().upsert({
            ids,
            embeddings,
            documents,
            metadatas,
        });
    }

    async removeByFile(filePath: string): Promise<void> {
        await this.ensure().delete({ where: { file_path: filePath } });
    }

    async vectorSearch(queryVector: number[], k: number): Promise<VectorHit[]> {
        const res = await this.ensure().query({
            queryEmbeddings: [normalize(queryVector)],
            nResults: k,
            include: ['documents', 'metadatas', 'distances'],
        });
        const ids = (res.ids?.[0] ?? []) as string[];
        const docs = (res.documents?.[0] ?? []) as Array<string | null>;
        const metas = (res.metadatas?.[0] ?? []) as Array<ChromaMeta | null>;
        const dists = (res.distances?.[0] ?? []) as Array<number | null>;
        const hits: VectorHit[] = [];
        for (let i = 0; i < ids.length; i++) {
            const meta = metas[i];
            if (!meta) {
                continue;
            }
            hits.push({
                record: {
                    id: ids[i],
                    filePath: meta.file_path,
                    startLine: meta.start_line,
                    endLine: meta.end_line,
                    language: meta.language,
                    nodeType: meta.node_type,
                    text: docs[i] ?? '',
                    vector: [],
                },
                score: 1 - (dists[i] ?? 1),
            });
        }
        return hits;
    }

    async getAll(): Promise<ChunkRecord[]> {
        const res = await this.ensure().get({ include: ['documents', 'metadatas'] });
        const ids = (res.ids ?? []) as string[];
        const docs = (res.documents ?? []) as Array<string | null>;
        const metas = (res.metadatas ?? []) as Array<ChromaMeta | null>;
        const records: ChunkRecord[] = [];
        for (let i = 0; i < ids.length; i++) {
            const meta = metas[i];
            if (!meta) {
                continue;
            }
            records.push({
                id: ids[i],
                filePath: meta.file_path,
                startLine: meta.start_line,
                endLine: meta.end_line,
                language: meta.language,
                nodeType: meta.node_type,
                text: docs[i] ?? '',
                vector: [],
            });
        }
        return records;
    }

    async count(): Promise<number> {
        return this.ensure().count();
    }

    async clear(): Promise<void> {
        if (!this.client) {
            return;
        }
        try {
            await this.client.deleteCollection({ name: COLLECTION });
        } catch {
            /* коллекции могло не быть */
        }
        this.collection = await this.getOrCreate();
    }

    async dispose(): Promise<void> {
        this.client = undefined;
        this.collection = undefined;
    }
}

/** Нормализация к единичной длине перед cosine-пространством коллекции. */
function normalize(v: number[]): number[] {
    let s = 0;
    for (let i = 0; i < v.length; i++) {
        const x = v[i];
        s += x * x;
    }
    const n = Math.sqrt(s) || 1;
    const out = new Array<number>(v.length);
    for (let i = 0; i < v.length; i++) {
        out[i] = v[i] / n;
    }
    return out;
}
