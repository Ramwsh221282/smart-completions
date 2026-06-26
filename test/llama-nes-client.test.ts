import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlamaSweepClient } from '../src/node/sweep/model-call-layer/llama-sweep-client';

test('llama Sweep client sends raw completions request', async () => {
    const originalFetch = globalThis.fetch;
    let body: unknown;
    globalThis.fetch = (async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ choices: [{ text: 'edit' }] }), { status: 200 });
    }) as typeof fetch;
    try {
        const client = new LlamaSweepClient();
        const text = await client.complete({
            baseUrl: 'http://127.0.0.1:8010/v1/',
            model: 'nes',
            prompt: 'prompt',
            stop: ['stop'],
            maxTokens: 32,
            temperature: 0.05,
        });
        assert.equal(text, 'edit');
        assert.deepEqual(body, {
            model: 'nes',
            prompt: 'prompt',
            max_tokens: 32,
            temperature: 0.05,
            stop: ['stop'],
            cache_prompt: true,
            seed: 0,
            stream: false,
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('llama Sweep client retries one busy server response', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
        calls++;
        if (calls === 1) {
            return new Response('', { status: 503, headers: { 'retry-after': '0' } });
        }
        return new Response(JSON.stringify({ choices: [{ text: 'after retry' }] }), { status: 200 });
    }) as typeof fetch;
    try {
        const client = new LlamaSweepClient();
        const text = await client.complete({
            baseUrl: 'http://127.0.0.1:8010/v1',
            model: 'nes',
            prompt: 'prompt',
            stop: [],
            maxTokens: 32,
            temperature: 0,
        });
        assert.equal(text, 'after retry');
        assert.equal(calls, 2);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
