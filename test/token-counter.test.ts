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

/** Проверяет, что длинные повторяющиеся фрагменты токенизируются один раз и дальше берутся из cache. */
test('QwenTokenCounter caches long tokenizer counts', () => {
    let calls = 0;
    const counter = new QwenTokenCounter() as unknown as { count(text: string): number; tokenizer: { encode(text: string): number[] } };
    counter.tokenizer = {
        encode(text: string): number[] {
            calls++;
            return new Array<number>(Math.max(1, Math.ceil(text.length / 20))).fill(1);
        },
    };
    const text = 'const cachedValue = user.displayName;\n'.repeat(12);

    const first = counter.count(text);
    const second = counter.count(text);

    assert.equal(first, second);
    assert.equal(calls, 1);
});

/** Проверяет, что короткие строки не кешируются, потому что md5 overhead дороже tokenization. */
test('QwenTokenCounter skips cache for short tokenizer counts', () => {
    let calls = 0;
    const counter = new QwenTokenCounter() as unknown as { count(text: string): number; tokenizer: { encode(text: string): number[] } };
    counter.tokenizer = {
        encode(): number[] {
            calls++;
            return [1, 2, 3];
        },
    };

    assert.equal(counter.count('short text'), 3);
    assert.equal(counter.count('short text'), 3);
    assert.equal(calls, 2);
});
