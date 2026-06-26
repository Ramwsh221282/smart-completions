import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bm25Index } from '../src/node/embedding-module/vector-store/bm25-index';
import { ChunkRecord } from '../src/node/embedding-module/vector-store/iface';

function rec(id: string, filePath: string, text: string): ChunkRecord {
    return { id, filePath, startLine: 1, endLine: 1, language: 'ts', nodeType: 'x', text, vector: [] };
}

test('bm25 ranks the most relevant document first', () => {
    const idx = new Bm25Index();
    idx.add([
        rec('1', 'a.ts', 'function computeTotalPrice(items) { return items }'),
        rec('2', 'b.ts', 'const greeting = "hello world"'),
        rec('3', 'c.ts', 'class UserRepository { findUser() {} }'),
    ]);
    assert.equal(idx.size, 3);
    const hits = idx.search('computeTotalPrice', 3);
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].record.id, '1');
});

test('bm25 add is idempotent by id', () => {
    const idx = new Bm25Index();
    idx.add([rec('1', 'a.ts', 'alpha beta')]);
    idx.add([rec('1', 'a.ts', 'alpha beta gamma')]);
    assert.equal(idx.size, 1);
});

test('bm25 removeByFile drops only that file', () => {
    const idx = new Bm25Index();
    idx.add([rec('1', 'a.ts', 'alpha'), rec('2', 'a.ts', 'beta'), rec('3', 'b.ts', 'gamma')]);
    idx.removeByFile('a.ts');
    assert.equal(idx.size, 1);
    assert.equal(idx.search('alpha', 5).length, 0);
    assert.equal(idx.search('gamma', 5).length, 1);
});

test('bm25 handles empty index and empty query', () => {
    const idx = new Bm25Index();
    assert.deepEqual(idx.search('x', 5), []);
    idx.add([rec('1', 'a.ts', 'hello there')]);
    assert.deepEqual(idx.search('', 5), []);
});
