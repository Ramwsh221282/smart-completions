import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkId } from '../src/node/embedding-module/chunker/chunk-meta';

test('chunkId is idempotent for same coordinates', () => {
    assert.equal(chunkId('a.ts', 1, 10), chunkId('a.ts', 1, 10));
});

test('chunkId is sensitive to path and line range', () => {
    assert.notEqual(chunkId('a.ts', 1, 10), chunkId('a.ts', 1, 11));
    assert.notEqual(chunkId('a.ts', 1, 10), chunkId('a.ts', 2, 10));
    assert.notEqual(chunkId('a.ts', 1, 10), chunkId('b.ts', 1, 10));
    assert.match(chunkId('a.ts', 1, 10), /^[0-9a-f]{32}$/);
});
