import * as fs from 'fs';
import * as path from 'path';
import { IndexProgress, IndexState, IndexStatus } from '../../../common/embedding-types';
import { normalizeCrlf } from '../../util/crlf';
import { Chunker } from '../chunker/chunker';
import { chunkId } from '../chunker/chunk-meta';
import { languageIdForExtension } from '../chunker/language-registry';
import { EmbedClient } from '../embed-client/llama-embed-client';
import { Bm25Index } from '../vector-store/bm25-index';
import { ChunkRecord, VectorStore } from '../vector-store/iface';
import { IndexIgnore, MAX_FILE_BYTES } from './ignore';
import { IndexMeta, IndexPersistence } from './persistence';

const EMBED_BATCH = 32;

export interface IndexerServices {
    chunker: Chunker;
    embed: EmbedClient;
    store: VectorStore;
    bm25: Bm25Index;
    transformDocumentText?: (text: string) => string;
}

export interface IndexerCallbacks {
    onStatus?(status: IndexStatus): void;
    onProgress?(progress: IndexProgress): void;
}

function toPosix(p: string): string {
    return p.split(path.sep).join('/');
}

function isInside(root: string, abs: string): boolean {
    const rel = path.relative(root, abs);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Индексатор репозитория: обход fs с гигиеной, чанкование, эмбеддинг (батчами),
 * идемпотентный upsert в vector-store + BM25, персистентность и reconcile.
 */
export class RepoIndexer {
    private state: IndexState = 'idle';
    private filesIndexed = 0;
    private totalFiles = 0;
    private meta: IndexMeta;

    constructor(
        private readonly roots: string[],
        private readonly services: IndexerServices,
        private readonly persistence: IndexPersistence,
        private readonly embedModel: string,
        private readonly callbacks: IndexerCallbacks = {},
    ) {
        this.meta = IndexPersistence.create(embedModel);
    }

    getStatus(): IndexStatus {
        return { state: this.state, filesIndexed: this.filesIndexed, totalFiles: this.totalFiles };
    }

    /** Полная переиндексация с нуля. */
    async rebuild(signal?: AbortSignal): Promise<void> {
        this.setState('indexing');
        try {
            await this.services.store.init();
            await this.services.store.clear();
            this.services.bm25.clear();
            this.meta = IndexPersistence.create(this.embedModel);
            const files = await this.collectFiles(signal);
            await this.indexBatch(files, signal);
            await this.persistence.save(this.meta);
            this.setState(signal?.aborted ? 'idle' : 'ready');
        } catch (e) {
            this.setError(e);
        }
    }

    /** Инкрементальная переиндексация одного файла (on-save). */
    async reindexFile(absPath: string, signal?: AbortSignal): Promise<void> {
        const root = this.roots.find(r => isInside(r, absPath));
        if (!root) {
            return;
        }
        const rel = toPosix(path.relative(root, absPath));
        await this.services.store.init();
        const ig = await IndexIgnore.load(root);
        let exists = true;
        try {
            await fs.promises.access(absPath);
        } catch {
            exists = false;
        }
        if (!exists || ig.isIgnored(rel) || !ig.isIndexableFile(rel)) {
            await this.removeFile(rel);
        } else {
            await this.indexFile(absPath, rel, signal);
        }
        await this.persistence.save(this.meta);
    }

    /** Восстановление с диска + сверка по mtime/size; при несовпадении модели — полный rebuild. */
    async reconcile(signal?: AbortSignal): Promise<void> {
        const persisted = await this.persistence.load();
        if (!persisted || persisted.embedModel !== this.embedModel) {
            return this.rebuild(signal);
        }
        this.setState('indexing');
        try {
            this.meta = persisted;
            await this.services.store.init();
            this.services.bm25.clear();
            try {
                this.services.bm25.add(await this.services.store.getAll());
            } catch {
                /* если store пуст/недоступен — продолжим */
            }
            const files = await this.collectFiles(signal);
            const currentSet = new Set(files.map(f => f.rel));
            this.totalFiles = files.length;
            this.filesIndexed = 0;
            for (const f of files) {
                if (signal?.aborted) {
                    break;
                }
                if (await this.isChanged(f.abs, f.rel)) {
                    await this.safeIndexFile(f.abs, f.rel, signal);
                }
                this.advance(f.rel);
            }
            for (const rel of Object.keys(this.meta.files)) {
                if (!currentSet.has(rel)) {
                    await this.removeFile(rel);
                }
            }
            await this.persistence.save(this.meta);
            this.setState(signal?.aborted ? 'idle' : 'ready');
        } catch (e) {
            this.setError(e);
        }
    }

    // --- внутреннее ---

    private async indexBatch(files: Array<{ abs: string; rel: string }>, signal?: AbortSignal): Promise<void> {
        this.totalFiles = files.length;
        this.filesIndexed = 0;
        for (const f of files) {
            if (signal?.aborted) {
                break;
            }
            await this.safeIndexFile(f.abs, f.rel, signal);
            this.advance(f.rel);
        }
    }

    private async safeIndexFile(abs: string, rel: string, signal?: AbortSignal): Promise<void> {
        try {
            await this.indexFile(abs, rel, signal);
        } catch {
            /* пер-файловая ошибка (напр. эмбеддинг недоступен) не валит весь индекс */
        }
    }

    private async indexFile(abs: string, rel: string, signal?: AbortSignal): Promise<void> {
        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(abs);
        } catch {
            return;
        }
        if (stat.size > MAX_FILE_BYTES) {
            return;
        }
        let content: string;
        try {
            content = normalizeCrlf(await fs.promises.readFile(abs, 'utf8'));
        } catch {
            return;
        }
        const languageId = languageIdForExtension(path.extname(rel));
        const chunks = await this.services.chunker.chunk(rel, content, languageId);

        await this.removeFileChunks(rel);
        if (chunks.length > 0) {
            const vectors = await this.embedAll(chunks.map(c => this.services.transformDocumentText ? this.services.transformDocumentText(c.text) : c.text), signal);
            const records: ChunkRecord[] = chunks.map((c, i) => ({
                id: chunkId(c.filePath, c.startLine, c.endLine),
                filePath: c.filePath,
                startLine: c.startLine,
                endLine: c.endLine,
                language: c.language,
                nodeType: c.nodeType,
                text: c.text,
                vector: vectors[i] ?? [],
            }));
            await this.services.store.upsert(records);
            this.services.bm25.add(records);
            if (vectors[0]) {
                this.meta.dim = vectors[0].length;
            }
        }
        this.meta.files[rel] = { mtimeMs: stat.mtimeMs, size: stat.size };
    }

    private async embedAll(texts: string[], signal?: AbortSignal): Promise<number[][]> {
        const out: number[][] = [];
        for (let i = 0; i < texts.length; i += EMBED_BATCH) {
            if (signal?.aborted) {
                break;
            }
            out.push(...(await this.services.embed.embed(texts.slice(i, i + EMBED_BATCH), signal)));
        }
        return out;
    }

    private async removeFileChunks(rel: string): Promise<void> {
        await this.services.store.removeByFile(rel);
        this.services.bm25.removeByFile(rel);
    }

    private async removeFile(rel: string): Promise<void> {
        await this.removeFileChunks(rel);
        delete this.meta.files[rel];
    }

    private async isChanged(abs: string, rel: string): Promise<boolean> {
        const prev = this.meta.files[rel];
        try {
            const st = await fs.promises.stat(abs);
            return !prev || prev.mtimeMs !== st.mtimeMs || prev.size !== st.size;
        } catch {
            return false;
        }
    }

    private async collectFiles(signal?: AbortSignal): Promise<Array<{ abs: string; rel: string }>> {
        const out: Array<{ abs: string; rel: string }> = [];
        for (const root of this.roots) {
            const ig = await IndexIgnore.load(root);
            await this.walk(root, root, ig, out, signal);
        }
        return out;
    }

    private async walk(
        dir: string,
        root: string,
        ig: IndexIgnore,
        out: Array<{ abs: string; rel: string }>,
        signal?: AbortSignal,
    ): Promise<void> {
        if (signal?.aborted) {
            return;
        }
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const abs = path.join(dir, entry.name);
            const rel = toPosix(path.relative(root, abs));
            if (entry.isDirectory()) {
                if (!ig.isIgnored(rel)) {
                    await this.walk(abs, root, ig, out, signal);
                }
            } else if (entry.isFile()) {
                if (!ig.isIgnored(rel) && ig.isIndexableFile(rel)) {
                    out.push({ abs, rel });
                }
            }
        }
    }

    private advance(currentFile: string): void {
        this.filesIndexed++;
        this.callbacks.onProgress?.({ processed: this.filesIndexed, total: this.totalFiles, currentFile });
    }

    private setState(state: IndexState): void {
        this.state = state;
        this.callbacks.onStatus?.(this.getStatus());
    }

    private setError(e: unknown): void {
        this.state = 'error';
        this.callbacks.onStatus?.({
            ...this.getStatus(),
            state: 'error',
            error: e instanceof Error ? e.message : String(e),
        });
    }
}
