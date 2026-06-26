import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkProse } from '../src/node/embedding-module/chunker/prose-chunker';

test('prose splits by blank-line paragraphs with correct line ranges', () => {
    const src = 'First paragraph line one.\nFirst paragraph line two.\n\nSecond paragraph here, long enough.';
    const chunks = chunkProse('doc.md', src, 'markdown');
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].startLine, 1);
    assert.ok(chunks[0].text.includes('First paragraph'));
    assert.equal(chunks[0].nodeType, 'paragraph');
    assert.equal(chunks[1].startLine, 4);
    assert.ok(chunks[1].text.includes('Second paragraph'));
});

test('prose skips paragraphs below min length', () => {
    const chunks = chunkProse('doc.md', 'hi\n\nThis is a sufficiently long paragraph of prose.', 'markdown');
    assert.equal(chunks.length, 1);
});

test('prose windows oversized paragraphs', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line number ${i} with content`).join('\n');
    const chunks = chunkProse('doc.txt', lines, 'plaintext', 40);
    assert.ok(chunks.length >= 3, `expected >=3 windows, got ${chunks.length}`);
});
