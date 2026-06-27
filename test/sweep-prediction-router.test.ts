import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSweepPrediction } from '../src/browser/sweep/trigger-layer/sweep-prediction-router';
import { normalizeCoreNesRouting } from '../src/common/model-types';
import type { NesResponse } from '../src/common/nes-types';

function response(modelId: string): NesResponse {
    return { edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'x' }], modelId };
}

test('core disabled routes straight to the TS backend without touching the core', async () => {
    let coreCalls = 0;
    let tsCalls = 0;
    const result = await resolveSweepPrediction(
        { coreEnabled: false, routing: 'fallback' },
        async () => { coreCalls += 1; return response('core'); },
        async () => { tsCalls += 1; return response('ts'); },
    );

    assert.equal(coreCalls, 0);
    assert.equal(tsCalls, 1);
    assert.equal(result?.modelId, 'ts');
});

test('core result is used and the TS backend is skipped when the core returns an edit', async () => {
    let tsCalls = 0;
    const result = await resolveSweepPrediction(
        { coreEnabled: true, routing: 'fallback' },
        async () => response('core'),
        async () => { tsCalls += 1; return response('ts'); },
    );

    assert.equal(tsCalls, 0);
    assert.equal(result?.modelId, 'core');
});

test('fallback routing falls through to the TS backend when the core returns nothing', async () => {
    let tsCalls = 0;
    const result = await resolveSweepPrediction(
        { coreEnabled: true, routing: 'fallback' },
        async () => undefined,
        async () => { tsCalls += 1; return response('ts'); },
    );

    assert.equal(tsCalls, 1);
    assert.equal(result?.modelId, 'ts');
});

test('core-only routing yields no suggestion and never calls the TS backend', async () => {
    let tsCalls = 0;
    const result = await resolveSweepPrediction(
        { coreEnabled: true, routing: 'core-only' },
        async () => undefined,
        async () => { tsCalls += 1; return response('ts'); },
    );

    assert.equal(tsCalls, 0);
    assert.equal(result, undefined);
});

test('normalizeCoreNesRouting keeps core-only and defaults unknown values to fallback', () => {
    assert.equal(normalizeCoreNesRouting('core-only'), 'core-only');
    assert.equal(normalizeCoreNesRouting('fallback'), 'fallback');
    assert.equal(normalizeCoreNesRouting(undefined), 'fallback');
    assert.equal(normalizeCoreNesRouting('bogus'), 'fallback');
});
