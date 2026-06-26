import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRegions, collectMarkerIndices, renderRegions } from '../src/common/zeta21/markers';

test('buildRegions falls back to the cursor line when syntactic bounds are missing', () => {
    const regions = buildRegions({ windowText: 'first\nsecond\nthird', cursorOffset: 'first\nsec'.length, syntacticBounds: null });

    assert.deepEqual(regions, [{ markerIndex: 1, startOffset: 6, endOffset: 12 }]);
});

test('buildRegions normalizes multi-region bounds and assigns stable marker pairs', () => {
    const regions = buildRegions({
        windowText: 'abcdef',
        cursorOffset: 1,
        syntacticBounds: [{ start: 4, end: 6 }, { start: 0, end: 2 }],
    });

    assert.deepEqual(regions, [
        { markerIndex: 1, startOffset: 0, endOffset: 2 },
        { markerIndex: 3, startOffset: 4, endOffset: 6 },
    ]);
});

test('renderRegions inserts cursor and marker pairs without losing content', () => {
    const rendered = renderRegions('abcdef', [
        { markerIndex: 1, startOffset: 0, endOffset: 2 },
        { markerIndex: 3, startOffset: 4, endOffset: 6 },
    ], 5);

    assert.equal(rendered, '<|marker_1|>ab<|marker_2|>cd<|marker_3|>e<|user_cursor|>f<|marker_4|>');
    assert.deepEqual(collectMarkerIndices(rendered), [1, 2, 3, 4]);
});
