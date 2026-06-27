import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSweepCompletion } from '../src/node/sweep/model-call-layer/sweep-response-parser';

test('Sweep parser returns line replacement edit for changed window', () => {
    const parsed = parseSweepCompletion({
        rawText: 'one\nTWO\nthree',
        oldWindowText: 'one\ntwo\nthree',
        windowStart: { line: 10, character: 0 },
        stopTokens: [],
    });

    assert.deepEqual(parsed.edits, [{
        range: { start: { line: 11, character: 0 }, end: { line: 12, character: 0 } },
        newText: 'TWO\n',
    }]);
    assert.deepEqual(parsed.jumpTo, { line: 11, character: 0 });
    assert.equal(parsed.status, 'edit');
    assert.equal(parsed.updatedWindow, 'one\nTWO\nthree');
});

test('Sweep parser ignores no-op sentinel', () => {
    const parsed = parseSweepCompletion({
        rawText: 'NO_EDITS',
        oldWindowText: 'one',
        windowStart: { line: 0, character: 0 },
        stopTokens: [],
    });
    assert.deepEqual(parsed.edits, []);
    assert.equal(parsed.status, 'no-edit');
    assert.equal(parsed.rejectReason, 'NO_EDITS');
});

test('Sweep parser rejects whitespace-only changes', () => {
    const parsed = parseSweepCompletion({
        rawText: 'one\n  two\nthree',
        oldWindowText: 'one\ntwo\nthree',
        windowStart: { line: 0, character: 0 },
        stopTokens: [],
    });
    assert.deepEqual(parsed.edits, []);
    assert.equal(parsed.status, 'rejected');
    assert.equal(parsed.rejectReason, 'whitespace-only');
});


