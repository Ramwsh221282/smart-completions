import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Neighbor } from '../src/common/embedding-types';
import { buildFimPrompt } from '../src/node/fim-module/context-formation/builder';

const FIXTURE = fs.readFileSync(path.join(process.cwd(), 'test/fixtures/fim-canonical-repo-prompt.txt'), 'utf8').trimEnd();

function neighbor(filePath: string, text: string, score: number): Neighbor {
    return { filePath, startLine: 1, endLine: 2, text, score };
}

test('qwen repo prompt matches canonical fixture and reverses retrieval neighbors', () => {
    const built = buildFimPrompt({
        modelId: 'qwen2.5-coder',
        fileMode: 'code',
        prefix: 'const value = ',
        suffix: ';',
        generationMode: 'multiline',
        contextSize: 4096,
        repoName: 'repo',
        filePath: 'src/current.ts',
        neighbors: [
            neighbor('src/best.ts', 'export const best = 2;', 10),
            neighbor('src/worse.ts', 'export const worse = 1;', 1),
        ],
    });

    assert.equal(built.prompt, FIXTURE);
});

test('qwen repo prompt places related files and recent edits before the current file block', () => {
    const built = buildFimPrompt({
        modelId: 'qwen2.5-coder',
        fileMode: 'code',
        prefix: 'return square(',
        suffix: ');',
        generationMode: 'multiline',
        contextSize: 4096,
        repoName: 'repo',
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

    const mathIndex = built.prompt.indexOf('<|file_sep|>src/math.ts');
    const typesIndex = built.prompt.indexOf('<|file_sep|>src/types.ts');
    const editIndex = built.prompt.indexOf('<|file_sep|>src/edit.ts');
    const currentIndex = built.prompt.indexOf('<|file_sep|>src/current.ts');

    assert.ok(mathIndex >= 0);
    assert.ok(typesIndex > mathIndex);
    assert.ok(editIndex > typesIndex);
    assert.ok(currentIndex > editIndex);
});
