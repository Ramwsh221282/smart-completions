import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeRankRelated, selectRelatedCandidates } from '../src/common/sweep/related-files';

test('selectRelatedCandidates ranks by score, keeps the highest-scored duplicate and full metadata', () => {
    const selected = selectRelatedCandidates([
        { filePath: 'a.ts', content: 'A', startLine: 1, endLine: 2, score: 0.2 },
        { filePath: 'b.ts', content: 'B', startLine: 1, endLine: 2, score: 0.9 },
        { filePath: 'a.ts', content: 'A-dup', startLine: 1, endLine: 2, score: 0.5 },
        { filePath: 'c.ts', content: 'C', startLine: 3, endLine: 4, score: 0.1 },
    ], 2);

    assert.deepEqual(selected, [
        { filePath: 'b.ts', content: 'B', startLine: 1, endLine: 2, score: 0.9 },
        { filePath: 'a.ts', content: 'A-dup', startLine: 1, endLine: 2, score: 0.5 },
    ]);
});

test('selectRelatedCandidates drops blank-content candidates and respects a disabled topN', () => {
    assert.deepEqual(selectRelatedCandidates([{ filePath: 'a.ts', content: '   ', score: 1 }], 5), []);
    assert.deepEqual(selectRelatedCandidates([{ filePath: 'a.ts', content: 'A', score: 1 }], 0), []);
});

test('dedupeRankRelated stays consistent with selectRelatedCandidates ordering', () => {
    const candidates = [
        { filePath: 'a.ts', content: 'A', startLine: 1, endLine: 2, score: 0.2 },
        { filePath: 'b.ts', content: 'B', startLine: 1, endLine: 2, score: 0.9 },
    ];

    const ranked = dedupeRankRelated(candidates, 5);
    const selected = selectRelatedCandidates(candidates, 5);

    assert.deepEqual(ranked, selected.map(candidate => ({ filePath: candidate.filePath, content: candidate.content })));
});
