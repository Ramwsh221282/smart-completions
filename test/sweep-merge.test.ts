import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Neighbor } from '../src/common/embedding-types';
import { mergeNeighborChannels } from '../src/node/sweep/retrieval/merge';

/** Создаёт Neighbor с устойчивым ключом для проверки RRF merge. */
function neighbor(filePath: string, startLine: number): Neighbor {
    return { filePath, startLine, endLine: startLine + 1, text: filePath, score: 0 };
}

/** Проверяет dedupe и RRF boost для общего кандидата из двух каналов. */
test('mergeNeighborChannels dedups by range and boosts shared candidates', () => {
    const merged = mergeNeighborChannels([
        [neighbor('a.ts', 1), neighbor('shared.ts', 1)],
        [neighbor('shared.ts', 1), neighbor('b.ts', 1)],
    ], 3);

    assert.equal(merged[0].filePath, 'shared.ts');
    assert.equal(merged.length, 3);
});

/** Проверяет topN и empty fast path. */
test('mergeNeighborChannels respects topN and empty input', () => {
    assert.deepEqual(mergeNeighborChannels([], 5), []);
    assert.equal(mergeNeighborChannels([[neighbor('a.ts', 1), neighbor('b.ts', 1)]], 1).length, 1);
});
