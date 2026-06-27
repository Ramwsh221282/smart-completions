import assert from 'node:assert/strict';
import { test } from 'node:test';
import { balanceCompletion } from '../src/node/fim-module/model-call/bracket-balance';

test('balanceCompletion trims a duplicated trailing closer from suffix', () => {
    assert.equal(balanceCompletion('return value\n}', '\n}'), 'return value\n');
});

test('balanceCompletion trims duplicated unmatched closers in suffix order', () => {
    assert.equal(balanceCompletion('call(value)\n)}', ')\n}'), 'call(value)\n');
});

test('balanceCompletion keeps matched internal pairs intact', () => {
    assert.equal(balanceCompletion('items.map(([key, value]) => value)', ';\n'), 'items.map(([key, value]) => value)');
});

test('balanceCompletion does not trim when the matching closer is not at the end', () => {
    assert.equal(balanceCompletion('value) more text }', ')\n}'), 'value) more text }');
});

test('balanceCompletion ignores closers inside strings', () => {
    assert.equal(balanceCompletion('const text = ")}"\n}', '\n}'), 'const text = ")}"\n');
});

test('balanceCompletion ignores closers inside comments', () => {
    assert.equal(balanceCompletion('value // )}\n}', '\n}'), 'value // )}\n');
});

test('balanceCompletion does not trim mismatched closer types', () => {
    assert.equal(balanceCompletion('result)', ']\nnext();'), 'result)');
});
