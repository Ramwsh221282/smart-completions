import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEmbedModelName } from '../src/node/embedding-module/embedding-service';

test('short aliases expand to full embedding model names', () => {
    assert.equal(resolveEmbedModelName('nomic'), 'nomic-embed-text');
    assert.equal(resolveEmbedModelName('granite'), 'granite-embedding');
});

test('any other embedding model name passes through unchanged', () => {
    assert.equal(resolveEmbedModelName('jina-code-embeddings-1.5b'), 'jina-code-embeddings-1.5b');
    assert.equal(resolveEmbedModelName('embeddinggemma-300M'), 'embeddinggemma-300M');
    assert.equal(resolveEmbedModelName('some/custom-model'), 'some/custom-model');
});
