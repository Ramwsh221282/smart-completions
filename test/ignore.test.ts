import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexIgnore } from '../src/node/embedding-module/indexer/ignore';

test('skip-dirs are ignored at any depth', () => {
    const ig = new IndexIgnore();
    assert.equal(ig.isIgnored('node_modules/x.js'), true);
    assert.equal(ig.isIgnored('a/node_modules/x.js'), true);
    assert.equal(ig.isIgnored('dist/bundle.js'), true);
    assert.equal(ig.isIgnored('src/index.ts'), false);
});

test('gitignore patterns are respected (glob, anchored, dir-only)', () => {
    const ig = new IndexIgnore(['*.log\n/secret.txt\nbuildlogs/\n']);
    assert.equal(ig.isIgnored('a/b/c.log'), true);
    assert.equal(ig.isIgnored('secret.txt'), true);
    assert.equal(ig.isIgnored('sub/secret.txt'), false);
    assert.equal(ig.isIgnored('buildlogs/x.txt'), true);
    assert.equal(ig.isIgnored('src/main.ts'), false);
});

test('isIndexableFile filters by extension', () => {
    const ig = new IndexIgnore();
    assert.equal(ig.isIndexableFile('a/b.ts'), true);
    assert.equal(ig.isIndexableFile('a/b.md'), true);
    assert.equal(ig.isIndexableFile('a/b.png'), false);
    assert.equal(ig.isIndexableFile('a/binary'), false);
});
