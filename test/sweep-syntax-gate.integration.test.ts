import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SweepSyntaxGate } from '../src/node/sweep/model-call-layer/syntax-gate';

/** Проверяет tree-sitter regression gate на реальной TypeScript grammar из tree-sitter-wasms. */
test('SweepSyntaxGate rejects TypeScript edits that increase parser errors', async t => {
    const gate = new SweepSyntaxGate();
    const delta = await gate.errorDelta('const value = 1;\n', 'const value = ;\n', 'typescript');
    if (delta === undefined) {
        t.skip('tree-sitter TypeScript grammar is unavailable');
        return;
    }
    assert.ok(delta > 0, `expected syntax error delta > 0, got ${delta}`);
});

/** Проверяет graceful bypass: prose/unsupported language не должен блокировать NES-правку. */
test('SweepSyntaxGate bypasses unsupported languages', async () => {
    const gate = new SweepSyntaxGate();
    const delta = await gate.errorDelta('plain text', 'plain text !', 'plaintext');
    assert.equal(delta, undefined);
});
