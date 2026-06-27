import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineCommentForLanguage } from '../src/common/granite41/line-comment';

test('lineCommentForLanguage resolves the expected comment prefix', () => {
    assert.equal(lineCommentForLanguage('python'), '#');
    assert.equal(lineCommentForLanguage('typescript'), '//');
    assert.equal(lineCommentForLanguage('sql'), '--');
    assert.equal(lineCommentForLanguage('lisp'), ';;');
    assert.equal(lineCommentForLanguage('unknown-language'), '//');
});
