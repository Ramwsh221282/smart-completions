import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SweepFuzzyChannel } from '../src/node/sweep/retrieval/fuzzy/sweep-fuzzy-channel';
import { SweepGraphIndexer } from '../src/node/sweep/retrieval/graph/sweep-graph-indexer';

/** Проверяет backend live path: source побеждает disk, а reindex без source откатывает graph к disk. */
test('SweepGraphIndexer live reindex uses dirty source and disk fallback restores saved file', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sc-graph-root-'));
    const cache = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sc-graph-cache-'));
    const file = path.join(root, 'user.ts');
    const uri = pathToFileURL(file).toString();
    await fs.promises.writeFile(file, 'export function savedName() { return true; }\n');

    const fuzzy = new SweepFuzzyChannel();
    const indexer = new SweepGraphIndexer(fuzzy);
    try {
        await indexer.configure([root], cache, true);
        assert.ok(indexer.getStore()?.declarationsByName('savedName', 5).length);

        await indexer.reindexFile(uri, 'export function dirtyName() { return false; }\n', 'typescript');
        assert.equal(indexer.getStore()?.declarationsByName('savedName', 5).length, 0);
        assert.ok(indexer.getStore()?.declarationsByName('dirtyName', 5).length);
        assert.equal(fuzzy.retrieve(['dirtyName'], 5)[0].filePath, 'user.ts');

        await indexer.reindexFile(uri);
        assert.ok(indexer.getStore()?.declarationsByName('savedName', 5).length);
        assert.equal(indexer.getStore()?.declarationsByName('dirtyName', 5).length, 0);

        await fs.promises.rm(file, { force: true });
        await indexer.reindexFile(uri);
        assert.equal(indexer.getStore()?.declarationsByName('savedName', 5).length, 0);
    } finally {
        indexer.dispose();
        await fs.promises.rm(root, { recursive: true, force: true });
        await fs.promises.rm(cache, { recursive: true, force: true });
    }
});
