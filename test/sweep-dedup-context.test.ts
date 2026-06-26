import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeContextFiles } from '../src/common/sweep/dedup-context';

/** Проверяет правила дедупликации между broad current file, related-файлами и RAG neighbors. */
test('dedupeContextFiles prefers related files over stale RAG neighbors', () => {
    const result = dedupeContextFiles({
        currentFilePath: './src/current.ts',
        relatedFiles: [
            { filePath: 'src/types.ts', content: 'export interface User { displayName: string; }' },
            { filePath: 'src/current.ts', content: 'fresh current related' },
        ],
        neighbors: [
            { filePath: 'src/types.ts', startLine: 1, endLine: 5, text: 'export interface User { fullName: string; }', score: 0.99 },
            { filePath: './src/current.ts', startLine: 1, endLine: 2, text: 'stale current neighbor', score: 0.9 },
            { filePath: 'src/dep.ts', startLine: 1, endLine: 2, text: 'export const dep = 1;', score: 0.8 },
            { filePath: 'src/dep.ts', startLine: 1, endLine: 2, text: 'export const dep = 1;', score: 0.7 },
        ],
    });

    assert.deepEqual(result.relatedFiles.map(file => file.filePath), ['src/types.ts']);
    assert.deepEqual(result.neighbors.map(file => file.filePath), ['src/dep.ts']);
    assert.deepEqual(result.dropped, {
        neighborsByCurrentFile: 1,
        neighborsByRelated: 1,
        relatedByCurrentFile: 1,
        neighborsByDup: 1,
    });
});
