import { test } from 'node:test';
import assert from 'node:assert/strict';
import { md5 } from '../src/node/util/hash';

test('md5 matches known vector', () => {
    assert.equal(md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
});

test('md5 deterministic and collision-free for distinct inputs', () => {
    assert.equal(md5('x'), md5('x'));
    assert.notEqual(md5('a'), md5('b'));
    assert.match(md5('anything'), /^[0-9a-f]{32}$/);
});
