import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charTokenEstimate, QwenTokenCounter } from '../src/node/sweep/token-budget/token-counter';

/** Проверяет дешёвый char fallback, который остаётся рабочим при повреждённом tokenizer bundle. */
test('charTokenEstimate is deterministic and non-zero for non-empty text', () => {
    assert.equal(charTokenEstimate(''), 0);
    assert.equal(charTokenEstimate('abcd'), 1);
    assert.equal(charTokenEstimate('abcde'), 2);
});

/** Проверяет offline tokenizer bundle: transformers.js не должен обращаться к сети при ensureReady(). */
test('QwenTokenCounter loads bundled tokenizer resources', { timeout: 120000 }, async () => {
    const counter = new QwenTokenCounter();
    await counter.ensureReady();
    assert.equal(counter.mode, 'tokenizer');
    assert.ok(counter.count('const value = 1;') > 0);
});
