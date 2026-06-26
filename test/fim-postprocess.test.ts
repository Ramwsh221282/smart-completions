import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postprocessFimCompletion } from '../src/node/fim-module/model-call/postprocess';

test('postprocess cuts line completions at newline', () => {
    const text = postprocessFimCompletion('value\nnext line', {
        suffix: '',
        generationMode: 'line',
        stopTokens: ['\n', '<|fim_prefix|>'],
    });
    assert.equal(text, 'value');
});

test('postprocess strips a leading newline and keeps the first line in line mode', () => {
    const text = postprocessFimCompletion('\n  (a, b) => a + b;\nmore code', {
        suffix: '',
        generationMode: 'line',
        stopTokens: [],
    });
    assert.equal(text, '  (a, b) => a + b;');
});

test('postprocess keeps a leading newline in multiline mode', () => {
    const text = postprocessFimCompletion('\n  body;', {
        suffix: '',
        generationMode: 'multiline',
        stopTokens: [],
    });
    assert.equal(text, '\n  body;');
});

test('postprocess cuts a trailing markdown code fence', () => {
    const text = postprocessFimCompletion('buildFimPrompt(input);\n}\n```', {
        suffix: '\n}',
        generationMode: 'multiline',
        stopTokens: [],
    });
    assert.ok(!text.includes('```'), `fence must be removed: ${JSON.stringify(text)}`);
    assert.ok(text.includes('buildFimPrompt(input);'));
});

test('postprocess unwraps a fully fenced completion', () => {
    const text = postprocessFimCompletion('```ts\nconst x = 1;\n```', {
        suffix: '',
        generationMode: 'multiline',
        stopTokens: [],
    });
    assert.equal(text, 'const x = 1;');
});

test('postprocess strips FIM tokens and normalizes line endings', () => {
    const text = postprocessFimCompletion('foo\r\nbar<|fim_suffix|>ignored', {
        suffix: '',
        generationMode: 'multiline',
        stopTokens: ['<|fim_suffix|>'],
    });
    assert.equal(text, 'foo\nbar');
});

test('postprocess trims echoed suffix prefix', () => {
    const text = postprocessFimCompletion('computedValue);', {
        suffix: ');\nnext();',
        generationMode: 'multiline',
        stopTokens: [],
    });
    assert.equal(text, 'computedValue');
});
