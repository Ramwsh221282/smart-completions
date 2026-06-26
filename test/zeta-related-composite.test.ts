import assert from 'node:assert/strict';
import URI from '@theia/core/lib/common/uri';
import { test } from 'node:test';
import { collectRelatedCandidates } from '../src/browser/zeta21/data-gathering-layer/related-source-composite';
import type { RelatedSource, RelatedSourceContext } from '../src/browser/zeta21/data-gathering-layer/sources/related-source';
import { dedupeRankRelated, type RelatedCandidate } from '../src/common/zeta21/related-files';

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

test('zeta related composite preserves source order for equal-score tie-breaks', async () => {
    const definition = source('definition', [{ filePath: 'a.ts', content: 'from-definition', startLine: 1, endLine: 5, score: 2 }]);
    const scm = source('scm', [{ filePath: 'a.ts', content: 'from-scm', startLine: 1, endLine: 5, score: 2 }]);

    const candidates = await collectRelatedCandidates([definition, scm], CTX);
    const ranked = dedupeRankRelated(candidates, 5);

    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].content, 'from-definition');
});

test('zeta related composite isolates a throwing source and keeps later results', async () => {
    const boom: RelatedSource = { id: 'boom', collect: async () => { throw new Error('x'); } };
    const ok = source('ok', [{ filePath: 'b.ts', content: 'kept', startLine: 1, endLine: 3, score: 2 }]);
    const seen: string[] = [];

    const candidates = await collectRelatedCandidates([boom, ok], CTX, id => seen.push(id));

    assert.deepEqual(seen, ['boom']);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].content, 'kept');
});
