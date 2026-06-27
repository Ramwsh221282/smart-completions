import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Neighbor } from '../src/common/embedding-types';
import { buildFimPrompt } from '../src/node/fim-module/context-formation/builder';

const FILE_LEVEL_FIXTURE = readFixture('test/fixtures/seed-canonical-fim-prompt.txt');
const REPO_FIXTURE = readFixture('test/fixtures/seed-repo-prompt.txt');

function readFixture(relativePath: string): string {
    return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8').trimEnd();
}

function neighbor(filePath: string, text: string, score: number): Neighbor {
    return { filePath, startLine: 1, endLine: 2, text, score };
}

test('seed repo prompt matches canonical fixture and keeps the strongest neighbor closest to the current file', () => {
    const built = buildFimPrompt({
        modelId: 'seed-coder-8b',
        languageId: 'typescript',
        fileMode: 'code',
        prefix: 'const value = ',
        suffix: ';',
        generationMode: 'multiline',
        contextSize: 4096,
        filePath: 'src/current.ts',
        neighbors: [
            neighbor('src/best.ts', 'export const best = 2;', 10),
            neighbor('src/worse.ts', 'export const worse = 1;', 1),
        ],
    });

    assert.equal(built.prompt, REPO_FIXTURE);
    assert.equal(built.maxTokens, 256);
});

test('seed falls back to canonical file-level SPM prompt when repo context is absent', () => {
    const built = buildFimPrompt({
        modelId: 'seed-coder-8b',
        languageId: 'typescript',
        fileMode: 'code',
        prefix: 'const value = ',
        suffix: ';',
        generationMode: 'multiline',
        contextSize: 4096,
        filePath: 'src/current.ts',
        neighbors: [],
    });

    assert.equal(built.prompt, FILE_LEVEL_FIXTURE);
});

test('seed repo prompt keeps related files and recent edits inside the stuffed prefix', () => {
    const built = buildFimPrompt({
        modelId: 'seed-coder-8b',
        languageId: 'typescript',
        fileMode: 'code',
        prefix: 'return square(',
        suffix: ');',
        generationMode: 'multiline',
        contextSize: 4096,
        filePath: 'src/current.ts',
        neighbors: [neighbor('src/math.ts', 'export function square(n: number) { return n * n; }', 3)],
        relatedFiles: [{ filePath: 'src/types.ts', content: 'export interface Point { x: number; y: number; }', score: 2 }],
        recentEdits: [{
            uri: 'src/edit.ts',
            before: 'const name = oldName;\n',
            after: 'const name = newName;\n',
            unifiedDiff: '@@ -1,1 +1,1 @@\n-const name = oldName;\n+const name = newName;',
            timestamp: 10,
        }],
    });

    const mathIndex = built.prompt.indexOf('// src/math.ts');
    const typesIndex = built.prompt.indexOf('// src/types.ts');
    const editIndex = built.prompt.indexOf('// edit_history src/edit.ts');
    const currentIndex = built.prompt.indexOf('// src/current.ts');

    assert.ok(mathIndex >= 0);
    assert.ok(typesIndex > mathIndex);
    assert.ok(editIndex > typesIndex);
    assert.ok(currentIndex > editIndex);
    assert.ok(built.prompt.startsWith('<[fim-suffix]>'));
});
