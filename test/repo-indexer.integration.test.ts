import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepoIndexer } from '../src/node/embedding-module/indexer/repo-indexer';
import { IndexPersistence } from '../src/node/embedding-module/indexer/persistence';
import { Chunker } from '../src/node/embedding-module/chunker/chunker';
import { Bm25Index } from '../src/node/embedding-module/vector-store/bm25-index';
import { ChunkRecord, VectorHit, VectorStore } from '../src/node/embedding-module/vector-store/iface';
import { EmbedClient } from '../src/node/embedding-module/embed-client/llama-embed-client';

// Дублёр векторного хранилища (in-memory) — позволяет тестировать индексатор без сервера.
class MemStore implements VectorStore {
    readonly records = new Map<string, ChunkRecord>();
    async init(): Promise<void> {}
    async upsert(recs: ChunkRecord[]): Promise<void> {
        for (const r of recs) {
            this.records.set(r.id, r);
        }
    }
    async removeByFile(fp: string): Promise<void> {
        for (const [id, r] of this.records) {
            if (r.filePath === fp) {
                this.records.delete(id);
            }
        }
    }
    async vectorSearch(_q: number[], k: number): Promise<VectorHit[]> {
        return [...this.records.values()].slice(0, k).map(record => ({ record, score: 1 }));
    }
    async getAll(): Promise<ChunkRecord[]> {
        return [...this.records.values()];
    }
    async count(): Promise<number> {
        return this.records.size;
    }
    async clear(): Promise<void> {
        this.records.clear();
    }
    async dispose(): Promise<void> {}
}

const fakeEmbed: EmbedClient = { async embed(inputs: string[]) { return inputs.map(() => [1, 0, 0]); } };

function makeIndexer(root: string, store: MemStore, bm25: Bm25Index, metaFile: string): RepoIndexer {
    return new RepoIndexer(
        [root],
        { chunker: new Chunker(), embed: fakeEmbed, store, bm25 },
        new IndexPersistence(metaFile),
        'nomic',
    );
}

test('rebuild indexes code + docs, skips ignored and node_modules', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sc-idx-'));
    await fs.promises.writeFile(path.join(root, '.gitignore'), '*.log\n');
    await fs.promises.writeFile(path.join(root, 'a.ts'), 'function foo(){ return 1; }\nclass Bar { m(){ return 2; } }');
    await fs.promises.writeFile(path.join(root, 'readme.md'), 'Paragraph one is long enough here.\n\nParagraph two also sufficiently long.');
    await fs.promises.mkdir(path.join(root, 'node_modules'));
    await fs.promises.writeFile(path.join(root, 'node_modules', 'skip.js'), 'function nope(){ return 0; }');
    await fs.promises.writeFile(path.join(root, 'debug.log'), 'noise '.repeat(20));

    const store = new MemStore();
    const bm25 = new Bm25Index();
    const indexer = makeIndexer(root, store, bm25, path.join(root, '.idx.json'));
    await indexer.rebuild();

    const files = new Set([...store.records.values()].map(r => r.filePath));
    assert.ok(files.has('a.ts'), 'a.ts indexed');
    assert.ok(files.has('readme.md'), 'readme.md indexed');
    assert.ok(![...files].some(f => f.includes('node_modules')), 'node_modules skipped');
    assert.ok(![...files].some(f => f.endsWith('.log')), '.log skipped');
    assert.ok(store.records.size >= 3, `expected >=3 chunks, got ${store.records.size}`);
    assert.equal(bm25.size, store.records.size, 'bm25 in sync with store');
    assert.equal(indexer.getStatus().state, 'ready');
});

test('reconcile reindexes changed files, drops deleted, restores bm25', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sc-rec-'));
    const aPath = path.join(root, 'a.ts');
    const bPath = path.join(root, 'b.ts');
    await fs.promises.writeFile(aPath, 'function aaa(){ return 1; }');
    await fs.promises.writeFile(bPath, 'function bbb(){ return 2; }');

    const store = new MemStore();
    const metaFile = path.join(root, '.idx.json');
    await makeIndexer(root, store, new Bm25Index(), metaFile).rebuild();
    assert.ok(store.records.size >= 2, `build produced ${store.records.size}`);

    await fs.promises.rm(bPath);
    await new Promise(r => setTimeout(r, 12)); // обновить mtime
    await fs.promises.writeFile(aPath, 'function aaa(){ return 1; }\nfunction ccc(){ return 3; }');

    // свежий BM25 (симуляция рестарта бэкенда); store сохраняется на «диске»
    const bm25Restarted = new Bm25Index();
    await makeIndexer(root, store, bm25Restarted, metaFile).reconcile();

    const files = [...store.records.values()].map(r => r.filePath);
    assert.ok(files.includes('a.ts'), 'a.ts present');
    assert.ok(!files.includes('b.ts'), 'deleted b.ts removed');
    assert.equal(bm25Restarted.size, store.records.size, 'bm25 restored + updated from store');
});
