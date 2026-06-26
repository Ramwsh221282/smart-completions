import { test } from 'node:test';
import assert from 'node:assert/strict';
import URI from '@theia/core/lib/common/uri';
import { dedupeRankRelated, RelatedCandidate } from '../src/common/sweep/related-files';
import { collectRelatedCandidates } from '../src/browser/sweep/data-gathering-layer/related-source-composite';
import type { RelatedSource, RelatedSourceContext } from '../src/browser/sweep/data-gathering-layer/sources/related-source';

const CTX: RelatedSourceContext = {
    languageId: 'typescript',
    uri: new URI('file:///cur.ts'),
    position: { line: 0, character: 0 },
    currentRelPath: 'cur.ts',
    queries: [],
};

function source(id: string, out: RelatedCandidate[]): RelatedSource {
    return { id, collect: async () => out };
}

test('collectRelatedCandidates preserves source order for equal-score tie-breaks', async () => {
    const hierarchy = source('hierarchy', [{ filePath: 'a.ts', content: 'from-hierarchy', startLine: 1, endLine: 5, score: 1 }]);
    const scm = source('scm', [{ filePath: 'a.ts', content: 'from-scm', startLine: 1, endLine: 5, score: 1 }]);

    const candidates = await collectRelatedCandidates([hierarchy, scm], CTX);
    const ranked = dedupeRankRelated(candidates, 5);

    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].content, 'from-hierarchy');
});

test('collectRelatedCandidates isolates a throwing source and keeps later results', async () => {
    const boom: RelatedSource = { id: 'boom', collect: async () => { throw new Error('x'); } };
    const ok = source('ok', [{ filePath: 'b.ts', content: 'kept', startLine: 1, endLine: 3, score: 2 }]);
    const seen: string[] = [];

    const candidates = await collectRelatedCandidates([boom, ok], CTX, id => seen.push(id));

    assert.deepEqual(seen, ['boom']);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].content, 'kept');
});

test('collectRelatedCandidates concatenates outputs in registration order', async () => {
    const a = source('a', [{ filePath: 'x.ts', content: 'A', score: 1 }]);
    const b = source('b', [{ filePath: 'y.ts', content: 'B', score: 1 }]);

    const out = await collectRelatedCandidates([a, b], CTX);

    assert.deepEqual(out.map(candidate => candidate.content), ['A', 'B']);
});
