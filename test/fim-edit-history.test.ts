import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEditHistorySnippets } from '../src/common/fim/fim-udiff';

test('buildEditHistorySnippets emits the last edits in chronological order', () => {
    const snippets = buildEditHistorySnippets('<|file_sep|>', [
        {
            uri: 'src/older.ts',
            before: 'const a = 1;\n',
            after: 'const alpha = 1;\n',
            unifiedDiff: '@@ -1,1 +1,1 @@\n-const a = 1;\n+const alpha = 1;',
            timestamp: 1,
        },
        {
            uri: 'src/newer.ts',
            before: 'const b = 2;\n',
            after: 'const beta = 2;\n',
            unifiedDiff: '@@ -1,1 +1,1 @@\n-const b = 2;\n+const beta = 2;',
            timestamp: 2,
        },
    ], 2);

    assert.equal(snippets.length, 2);
    assert.ok(snippets[0].startsWith('<|file_sep|>src/older.ts\n'));
    assert.ok(snippets[1].startsWith('<|file_sep|>src/newer.ts\n'));
    assert.ok(snippets[0].includes('--- a/src/older.ts'));
    assert.ok(snippets[1].includes('+const beta = 2;'));
});

test('buildEditHistorySnippets falls back to stored unifiedDiff and returns empty for no edits', () => {
    const fallback = buildEditHistorySnippets('<|file_sep|>', [{
        uri: 'src/a.ts',
        unifiedDiff: '@@ -1,1 +1,1 @@\n-old\n+new',
        timestamp: 1,
    }], 1);

    assert.deepEqual(buildEditHistorySnippets('<|file_sep|>', [], 3), []);
    assert.ok(fallback[0].includes('@@ -1,1 +1,1 @@'));
});
