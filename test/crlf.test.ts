import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCrlf } from '../src/node/util/crlf';

test('normalizeCrlf converts CRLF and lone CR to LF', () => {
    assert.equal(normalizeCrlf('a\r\nb\rc\nd'), 'a\nb\nc\nd');
});

test('normalizeCrlf leaves clean text untouched', () => {
    assert.equal(normalizeCrlf('no newlines'), 'no newlines');
    assert.equal(normalizeCrlf('a\nb\nc'), 'a\nb\nc');
});
