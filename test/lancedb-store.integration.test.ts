import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LanceVectorStore } from '../src/node/embedding-module/vector-store/lancedb-store';
import { ChunkRecord } from '../src/node/embedding-module/vector-store/iface';

// Интеграционный тест встроенного LanceDB (native napi). Сервер не нужен.

function rec(id: string, filePath: string, vector: number[], text: string): ChunkRecord {
    return { id, filePath, startLine: 1, endLine: 2, language: 'ts', nodeType: 'function_declaration', text, vector };
}

test('lancedb upsert/vectorSearch/getAll/removeByFile/count/clear', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sc-lance-'));
    const store = new LanceVectorStore(dir);
    await store.init();

    await store.upsert([
        rec('1', 'a.ts', [1, 0, 0], 'alpha function'),
        rec('2', 'b.ts', [0, 1, 0], 'beta function'),
        rec('3', 'a.ts', [0.9, 0.1, 0], 'alpha helper'),
    ]);
    assert.equal(await store.count(), 3);

    const hits = await store.vectorSearch([1, 0, 0], 2);
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].record.id, '1', 'nearest vector is id 1');
    assert.ok(hits[0].score > hits[hits.length - 1].score - 1e-9);

    const all = await store.getAll();
    assert.equal(all.length, 3);
    assert.ok(all.every(r => typeof r.filePath === 'string' && r.startLine === 1));

    await store.removeByFile('a.ts');
    assert.equal(await store.count(), 1, 'only b.ts remains');

    // идемпотентный upsert по id
    await store.upsert([rec('2', 'b.ts', [0, 1, 0], 'beta updated')]);
    assert.equal(await store.count(), 1);

    await store.clear();
    assert.equal(await store.count(), 0);
    await store.dispose();
});
