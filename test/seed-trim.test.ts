import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SEED_MODULE } from '../src/common/seedcoder/seed-module';
import { trimFimContext } from '../src/node/fim-module/context-formation/semantic-trim';

test('seed reserved chars leave room for the current file when stuffed repo context grows', () => {
    const prefix = `function demo() {\n${'  const value = 1;\n'.repeat(200)}`;
    const suffix = 'return value;\n}'.repeat(40);
    const loose = trimFimContext(prefix, suffix, { fileMode: 'code', contextSize: 2048, reservedChars: 0 });
    const reservedChars = SEED_MODULE.countReservedChars({
        languageId: 'typescript',
        repoName: 'repo',
        filePath: 'src/current.ts',
        prefix: '',
        suffix: '',
        neighbors: [{ filePath: 'src/neighbor.ts', startLine: 1, endLine: 10, text: 'export const value = 1;'.repeat(40), score: 1 }],
        relatedFiles: [{ filePath: 'src/types.ts', content: 'export interface Point { x: number; y: number; }'.repeat(20) }],
        editSnippets: ['// edit_history src/edit.ts\n@@ -1,1 +1,1 @@\n-old\n+new'],
        useRepoContext: true,
    });
    const tight = trimFimContext(prefix, suffix, { fileMode: 'code', contextSize: 2048, reservedChars });

    assert.ok(loose.prefix.length > tight.prefix.length);
    assert.ok(tight.prefix.length > 0);
    assert.ok(loose.suffix.length >= tight.suffix.length);
});
