import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAixcoderHeader, languageDisplayName } from '../src/common/aixcoder/aixcoder-header';

test('buildAixcoderHeader matches the canonical aiXcoder header format', () => {
    assert.equal(
        buildAixcoderHeader('src/demo.ts', 'typescript'),
        '# the file path is: src/demo.ts\n# the code file is written by TypeScript\n',
    );
});

test('languageDisplayName resolves known language ids', () => {
    assert.equal(languageDisplayName('python'), 'Python');
    assert.equal(languageDisplayName('typescriptreact'), 'TypeScript');
});

test('languageDisplayName falls back to capitalization for unknown ids', () => {
    assert.equal(languageDisplayName('zig'), 'Zig');
    assert.equal(languageDisplayName(''), 'Text');
});
