import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reciprocalRankFusion } from '../src/node/embedding-module/retriever/hybrid-retriever';
import { VectorHit } from '../src/node/embedding-module/vector-store/iface';

function hit(id: string): VectorHit {
    return {
        record: { id, filePath: `${id}.ts`, startLine: 1, endLine: 1, language: 'ts', nodeType: 'x', text: '', vector: [] },
        score: 0,
    };
}

test('rrf ranks a doc present in both lists highest', () => {
    const vector = [hit('a'), hit('b'), hit('c')];
    const lexical = [hit('b'), hit('d')];
    const out = reciprocalRankFusion([vector, lexical], 3);
    assert.equal(out[0].record.id, 'b');
    assert.equal(out.length, 3);
});

test('rrf dedups ids and respects topN', () => {
    const a = [hit('x'), hit('y'), hit('z')];
    const out = reciprocalRankFusion([a, []], 2);
    assert.equal(out.length, 2);
    assert.equal(out[0].record.id, 'x');
});

test('rrf empty input yields empty output', () => {
    assert.deepEqual(reciprocalRankFusion([[], []], 5), []);
});
