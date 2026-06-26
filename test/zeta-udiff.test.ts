import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEditHistoryBlock } from '../src/common/zeta21/udiff';

test('buildEditHistoryBlock keeps unified diff headers and chronological order', () => {
    const block = buildEditHistoryBlock([
        { uri: 'file:///repo/new.ts', unifiedDiff: '--- a/new.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-old\n+new', timestamp: 2 },
        { uri: 'file:///repo/old.ts', unifiedDiff: '--- a/old.ts\n+++ b/old.ts\n@@ -1 +1 @@\n-a\n+b', timestamp: 1 },
    ]);

    assert.ok(block.startsWith('<filename>edit_history\n--- a/old.ts'));
    assert.ok(block.includes('+++ b/new.ts'));
    assert.ok(block.indexOf('old.ts') < block.indexOf('new.ts'));
});

test('buildEditHistoryBlock returns empty string when there are no recent edits', () => {
    assert.equal(buildEditHistoryBlock([]), '');
});
