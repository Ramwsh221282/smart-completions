import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FimCompletionCache, type FimCacheKeyInput } from '../src/browser/fim-module/fim-completion-cache';

const BASE_KEY: FimCacheKeyInput = {
    uri: 'file:///workspace/example.ts',
    fileMode: 'code',
    generationMode: 'multiline',
    prefix: 'const answer = ',
    suffix: ';\n',
};

test('FimCompletionCache returns an exact hit for the same key', () => {
    const cache = new FimCompletionCache();
    cache.store(BASE_KEY, 'computeAnswer()');
    assert.equal(cache.lookup(BASE_KEY), 'computeAnswer()');
});

test('FimCompletionCache invalidates when suffix changes', () => {
    const cache = new FimCompletionCache();
    cache.store(BASE_KEY, 'computeAnswer()');
    assert.equal(cache.lookup({ ...BASE_KEY, suffix: '\n' }), null);
});

test('FimCompletionCache returns the remaining completion for prefix extension', () => {
    const cache = new FimCompletionCache();
    cache.store(BASE_KEY, 'computeAnswer()');
    assert.equal(cache.lookup({ ...BASE_KEY, prefix: `${BASE_KEY.prefix}compute` }), 'Answer()');
});

test('FimCompletionCache rejects prefix extension when typed text diverges', () => {
    const cache = new FimCompletionCache();
    cache.store(BASE_KEY, 'computeAnswer()');
    assert.equal(cache.lookup({ ...BASE_KEY, prefix: `${BASE_KEY.prefix}compare` }), null);
});

test('FimCompletionCache rejects prefix extension when generation mode changes', () => {
    const cache = new FimCompletionCache();
    cache.store(BASE_KEY, 'computeAnswer()');
    assert.equal(cache.lookup({ ...BASE_KEY, generationMode: 'line', prefix: `${BASE_KEY.prefix}compute` }), null);
});

test('FimCompletionCache clear removes exact hits and prefix-extension state', () => {
    const cache = new FimCompletionCache();
    cache.store(BASE_KEY, 'computeAnswer()');
    cache.clear();
    assert.equal(cache.lookup(BASE_KEY), null);
    assert.equal(cache.lookup({ ...BASE_KEY, prefix: `${BASE_KEY.prefix}compute` }), null);
});

test('FimCompletionCache does not store empty completions', () => {
    const cache = new FimCompletionCache();
    cache.store(BASE_KEY, '');
    assert.equal(cache.lookup(BASE_KEY), null);
});

test('FimCompletionCache evicts the oldest exact hit when max entries is exceeded', () => {
    const cache = new FimCompletionCache();
    cache.store(BASE_KEY, 'first()');
    for (let index = 0; index < 200; index++) {
        cache.store({
            ...BASE_KEY,
            uri: `file:///workspace/file-${index}.ts`,
            prefix: `const value${index} = `,
        }, `value${index}()`);
    }
    assert.equal(cache.lookup(BASE_KEY), null);
});
