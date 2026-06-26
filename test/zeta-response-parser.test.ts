import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseZetaCompletion } from '../src/node/zeta21/model-call-layer/zeta-response-parser';

test('parseZetaCompletion extracts one edited region and strips marker noise', () => {
    const parsed = parseZetaCompletion({
        rawText: '<|marker_1|>\naXbc\n<|marker_2|>',
        windowText: 'abc',
        windowStart: { line: 5, character: 0 },
        regions: [{ markerIndex: 1, startOffset: 0, endOffset: 3 }],
        stopTokens: ['<|endoftext|>', '<[fim-suffix]>', '<[fim-prefix]>'],
    });

    assert.equal(parsed.status, 'edit');
    assert.equal(parsed.edits.length, 1);
    assert.equal(parsed.edits[0].newText, 'aXbc');
    assert.deepEqual(parsed.primaryRange?.start, { line: 5, character: 0 });
});

test('parseZetaCompletion supports multiple marker pairs', () => {
    const parsed = parseZetaCompletion({
        rawText: '<|marker_1|>\nFOO\n<|marker_2|> gap <|marker_3|>\nBAZ\n<|marker_4|>',
        windowText: 'foo gap baz',
        windowStart: { line: 0, character: 0 },
        regions: [
            { markerIndex: 1, startOffset: 0, endOffset: 3 },
            { markerIndex: 3, startOffset: 8, endOffset: 11 },
        ],
        stopTokens: ['<|endoftext|>', '<[fim-suffix]>', '<[fim-prefix]>'],
    });

    assert.equal(parsed.edits.length, 2);
    assert.deepEqual(parsed.edits.map(edit => edit.newText), ['FOO', 'BAZ']);
});

test('parseZetaCompletion returns no-edit for incomplete marker pairs and rejects whitespace-only edits', () => {
    const missing = parseZetaCompletion({
        rawText: '<|marker_1|>oops',
        windowText: 'abc',
        windowStart: { line: 0, character: 0 },
        regions: [{ markerIndex: 1, startOffset: 0, endOffset: 3 }],
        stopTokens: ['<|endoftext|>', '<[fim-suffix]>', '<[fim-prefix]>'],
    });
    const rejected = parseZetaCompletion({
        rawText: '<|marker_1|>\na b c\n<|marker_2|>',
        windowText: 'abc',
        windowStart: { line: 0, character: 0 },
        regions: [{ markerIndex: 1, startOffset: 0, endOffset: 3 }],
        stopTokens: ['<|endoftext|>', '<[fim-suffix]>', '<[fim-prefix]>'],
    });

    assert.equal(missing.status, 'no-edit');
    assert.equal(missing.edits.length, 0);
    assert.equal(rejected.status, 'rejected');
});
