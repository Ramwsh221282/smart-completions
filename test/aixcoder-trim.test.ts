import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAixcoderHeader } from '../src/common/aixcoder/aixcoder-header';
import { AIX_SPAN_POST } from '../src/common/aixcoder/aixcoder-tokens';
import { buildFimPrompt } from '../src/node/fim-module/context-formation/builder';

const CURRENT_HEADER = buildAixcoderHeader('src/current.ts', 'typescript');

test('aixcoder trims more current-file prefix when repo context reserves prompt budget', () => {
    const prefix = `function demo() {\n${'  const value = 1;\n'.repeat(200)}`;
    const suffix = 'return value;\n}'.repeat(20);

    const withoutRepo = buildFimPrompt({
        modelId: 'aixcoder-7b-v2',
        languageId: 'typescript',
        fileMode: 'code',
        prefix,
        suffix,
        generationMode: 'multiline',
        contextSize: 2048,
        filePath: 'src/current.ts',
    });
    const withRepo = buildFimPrompt({
        modelId: 'aixcoder-7b-v2',
        languageId: 'typescript',
        fileMode: 'code',
        prefix,
        suffix,
        generationMode: 'multiline',
        contextSize: 2048,
        filePath: 'src/current.ts',
        neighbors: [{
            filePath: 'src/neighbor.ts',
            startLine: 1,
            endLine: 200,
            text: 'export const neighbor = 1;\n'.repeat(80),
            score: 1,
        }],
    });

    const withoutRepoPrefix = withoutRepo.prompt.slice(withoutRepo.prompt.indexOf(CURRENT_HEADER) + CURRENT_HEADER.length);
    const withRepoStart = withRepo.prompt.indexOf(CURRENT_HEADER) + CURRENT_HEADER.length;
    const withRepoEnd = withRepo.prompt.indexOf(AIX_SPAN_POST, withRepoStart);
    const withRepoPrefix = withRepo.prompt.slice(withRepoStart, withRepoEnd);

    assert.ok(withRepo.prompt.includes(buildAixcoderHeader('src/neighbor.ts', 'typescript')));
    assert.ok(withoutRepoPrefix.length > withRepoPrefix.length);
});
