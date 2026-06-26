import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyMatryoshka, buildDocumentInput, buildQueryInput, FimPooling } from '../src/common/fim/fim-embedder';
import { getFimEmbedderProfile } from '../src/common/fim/fim-embedder-registry';

test('jina-code profile prefixes query and document inputs', () => {
    const profile = getFimEmbedderProfile('jina-code');
    assert.equal(buildQueryInput(profile, 'return value'), 'Represent the incomplete code for completion: return value');
    assert.equal(buildDocumentInput(profile, 'export const value = 1;'), 'Represent the code snippet for retrieval: export const value = 1;');
    assert.equal(profile.pooling, FimPooling.LastToken);
    assert.equal(profile.dimension, 896);
});

test('granite profile leaves inputs unchanged and matryoshka trims when requested', () => {
    const granite = getFimEmbedderProfile('granite');
    const custom = { ...granite, matryoshkaDim: 2 };
    const vector = Float32Array.from([1, 2, 3, 4]);

    assert.equal(buildQueryInput(granite, 'x'), 'x');
    assert.equal(buildDocumentInput(granite, 'y'), 'y');
    assert.deepEqual(Array.from(applyMatryoshka(custom, vector)), [1, 2]);
    assert.deepEqual(Array.from(applyMatryoshka(granite, vector)), [1, 2, 3, 4]);
});
