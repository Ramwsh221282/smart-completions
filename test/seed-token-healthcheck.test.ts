import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifySeedSpecialTokens } from '../src/node/seedcoder/seed-token-healthcheck';

test('verifySeedSpecialTokens hits raw /tokenize and accepts one id per token', async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ tokens: [42] }), { status: 200 });
    }) as typeof fetch;
    try {
        const ok = await verifySeedSpecialTokens('http://127.0.0.1:8020/v1');

        assert.equal(ok, true);
        assert.deepEqual(urls, [
            'http://127.0.0.1:8020/tokenize',
            'http://127.0.0.1:8020/tokenize',
            'http://127.0.0.1:8020/tokenize',
        ]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('verifySeedSpecialTokens fails when a token splits into multiple ids', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
        calls++;
        return new Response(JSON.stringify({ tokens: calls === 3 ? [1, 2] : [1] }), { status: 200 });
    }) as typeof fetch;
    try {
        const ok = await verifySeedSpecialTokens('http://127.0.0.1:8020');

        assert.equal(ok, false);
        assert.equal(calls, 3);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
