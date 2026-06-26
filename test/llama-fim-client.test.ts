import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlamaFimClient } from '../src/node/fim-module/model-call/llama-fim-client';

test('llama FIM client sends raw completions request', async () => {
    const originalFetch = globalThis.fetch;
    let body: any;
    globalThis.fetch = (async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ choices: [{ text: 'ok' }] }), { status: 200 });
    }) as typeof fetch;
    try {
        const client = new LlamaFimClient();
        const text = await client.complete({
            baseUrl: 'http://127.0.0.1:8020/v1/',
            model: 'model',
            prompt: '<fim>',
            stop: ['stop'],
            maxTokens: 12,
            temperature: 0.05,
        });
        assert.equal(text, 'ok');
        assert.deepEqual(body, {
            model: 'model',
            prompt: '<fim>',
            max_tokens: 12,
            temperature: 0.05,
            stop: ['stop'],
            stream: false,
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('llama FIM client retries one busy server response', async () => {
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
        const client = new LlamaFimClient();
        const text = await client.complete({
            baseUrl: 'http://127.0.0.1:8020/v1',
            model: 'model',
            prompt: '<fim>',
            stop: [],
            maxTokens: 12,
            temperature: 0,
        });
        assert.equal(text, 'after retry');
        assert.equal(calls, 2);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
