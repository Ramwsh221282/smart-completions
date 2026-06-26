import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trimFimContext } from '../src/node/fim-module/context-formation/semantic-trim';

test('trimFimContext reserves more space for external context when reservedChars grows', () => {
    const prefix = `function demo() {\n${'  const value = 1;\n'.repeat(200)}`;
    const suffix = 'return value;\n}'.repeat(40);
    const loose = trimFimContext(prefix, suffix, { fileMode: 'code', contextSize: 2048, reservedChars: 0 });
    const tight = trimFimContext(prefix, suffix, { fileMode: 'code', contextSize: 2048, reservedChars: 1800 });

    assert.ok(loose.prefix.length > tight.prefix.length);
    assert.ok(loose.suffix.length >= tight.suffix.length);
});

test('trimFimContext keeps useful prose boundaries when trimming paragraphs', () => {
    const prefix = `Title\n\n${'Paragraph one. '.repeat(80)}\n\n${'Paragraph two. '.repeat(80)}`;
    const suffix = `${'Tail. '.repeat(80)}\n\n${'Next. '.repeat(80)}`;
    const trimmed = trimFimContext(prefix, suffix, { fileMode: 'prose', contextSize: 1024, reservedChars: 400 });

    assert.ok(trimmed.prefix.length > 0);
    assert.ok(trimmed.suffix.length > 0);
    assert.ok(trimmed.suffix.length < suffix.length);
});
