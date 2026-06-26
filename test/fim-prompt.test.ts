import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Neighbor } from '../src/common/embedding-types';
import { buildFimPrompt } from '../src/node/fim-module/context-formation/builder';

const neighbor: Neighbor = {
    filePath: 'src/neighbor.ts',
    startLine: 1,
    endLine: 3,
    text: 'export function neighbor() {\n  return 1;\n}',
    score: 1,
};

test('qwen prompt fills repo and file slots before native FIM tokens', () => {
    const built = buildFimPrompt({
        modelId: 'qwen2.5-coder',
        fileMode: 'code',
        prefix: 'const value = ',
        suffix: ';\n',
        generationMode: 'multiline',
        contextSize: 4096,
        repoName: 'repo',
        filePath: 'src/current.ts',
        neighbors: [neighbor],
    });

    assert.ok(built.prompt.startsWith('<|repo_name|>repo\n<|file_sep|>src/neighbor.ts'));
    assert.ok(built.prompt.includes('<|file_sep|>src/current.ts\n<|fim_prefix|>const value = <|fim_suffix|>;\n<|fim_middle|>'));
    assert.equal(built.stop.includes('\n'), false);
    assert.equal(built.maxTokens, 160);
});

test('deepseek prompt keeps only native FIM slots', () => {
    const built = buildFimPrompt({
        modelId: 'deepseek-coder',
        fileMode: 'code',
        prefix: 'a',
        suffix: 'b',
        generationMode: 'line',
        contextSize: 4096,
        repoName: 'repo',
        filePath: 'src/current.ts',
        neighbors: [neighbor],
    });

    assert.equal(built.prompt, '<｜fim▁begin｜>a<｜fim▁hole｜>b<｜fim▁end｜>');
    assert.ok(!built.stop.includes('\n'), 'newline is not used as a server stop token');
    assert.equal(built.maxTokens, 48);
});

test('granite prompt uses granite repo tokens when neighbors are present', () => {
    const built = buildFimPrompt({
        modelId: 'granite-4.1-3b',
        fileMode: 'prose',
        prefix: 'Hello ',
        suffix: ' world',
        generationMode: 'block',
        contextSize: 4096,
        repoName: 'repo',
        filePath: 'notes.md',
        neighbors: [neighbor],
    });

    assert.ok(built.prompt.startsWith('<|reponame|>repo\n<|filename|>src/neighbor.ts'));
    assert.ok(built.prompt.includes('<|filename|>notes.md\n<|fim_prefix|>Hello <|fim_suffix|> world<|fim_middle|>'));
    assert.equal(built.maxTokens, 384);
});

test('granite without neighbors falls back to file-level FIM (no fabricated repo slots)', () => {
    const built = buildFimPrompt({
        modelId: 'granite-4.1-8b',
        fileMode: 'code',
        prefix: 'const x = ',
        suffix: ';',
        generationMode: 'multiline',
        contextSize: 4096,
        repoName: 'repo',
        filePath: 'src/current.ts',
        neighbors: [],
    });

    assert.equal(built.prompt, '<|fim_prefix|>const x = <|fim_suffix|>;<|fim_middle|>');
    assert.ok(!built.prompt.includes('<|reponame|>'));
    assert.ok(!built.prompt.includes('<|filename|>'));
});

test('qwen without neighbors falls back to file-level FIM', () => {
    const built = buildFimPrompt({
        modelId: 'qwen2.5-coder',
        fileMode: 'code',
        prefix: 'let y = ',
        suffix: '',
        generationMode: 'line',
        contextSize: 4096,
        repoName: 'repo',
        filePath: 'src/current.ts',
        neighbors: [],
    });

    assert.equal(built.prompt, '<|fim_prefix|>let y = <|fim_suffix|><|fim_middle|>');
    assert.ok(!built.prompt.includes('<|repo_name|>'));
    assert.ok(!built.prompt.includes('<|file_sep|>'));
});
