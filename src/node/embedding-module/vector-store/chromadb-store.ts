import { ChromaClient } from 'chromadb';
import { ChunkRecord, VectorHit, VectorStore } from './iface';

const COLLECTION = 'smart_completions_chunks';

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

interface ChromaMeta {
    file_path: string;
    start_line: number;
    end_line: number;
    language: string;
    node_type: string;
}

/**
 * ChromaDB-хранилище (сервер через pipx, HTTP). Векторы поставляем сами
 * (embeddingFunction: null). Лексическая половина гибрида — отдельный Bm25Index.
 */
export class ChromaVectorStore implements VectorStore {
    private client: ChromaClient | undefined;
    // CollectionImpl — структурные типы chromadb сложны; на границе используем any.
    private collection: any;

    constructor(private readonly chromaUrl: string) {}

    async init(): Promise<void> {
        const u = new URL(this.chromaUrl);
        const ssl = u.protocol === 'https:';
        const port = u.port ? parseInt(u.port, 10) : ssl ? 443 : 80;
        this.client = new ChromaClient({ host: u.hostname, port, ssl });
        this.collection = await this.getOrCreate();
    }

    private async getOrCreate(): Promise<any> {
        // Явное cosine-пространство: дефолт Chroma — L2, на котором нулевые/короткие векторы
        // ложно оказываются ближе к запросу. Cosine совпадает с поведением LanceDB-стора.
        return this.client!.getOrCreateCollection({
            name: COLLECTION,
            embeddingFunction: null,
            configuration: { hnsw: { space: 'cosine' } },
        } as any);
    }

    private ensure(): any {
        if (!this.collection) {
            throw new Error('ChromaVectorStore not initialized');
        }
        return this.collection;
    }

    async upsert(records: ChunkRecord[]): Promise<void> {
        if (records.length === 0) {
            return;
        }
        await this.ensure().upsert({
            ids: records.map(r => r.id),
            embeddings: records.map(r => normalize(r.vector)),
            documents: records.map(r => r.text),
            metadatas: records.map(
                r =>
                    ({
                        file_path: r.filePath,
                        start_line: r.startLine,
                        end_line: r.endLine,
                        language: r.language,
                        node_type: r.nodeType,
                    }) as ChromaMeta,
            ),
        });
    }

    async removeByFile(filePath: string): Promise<void> {
        await this.ensure().delete({ where: { file_path: filePath } as any });
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
