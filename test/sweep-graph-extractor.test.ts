import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractGraphFromFile } from '../src/node/sweep/retrieval/graph/sweep-graph-extractor';
import { SweepTreeSitter } from '../src/node/sweep/retrieval/graph/sweep-tree-sitter-loader';

/** Проверяет извлечение symbols/refs из TypeScript через tree-sitter или fallback без внешних серверов. */
test('extractGraphFromFile extracts TypeScript declarations and references', async () => {
    const source = [
        'export interface User { displayName: string }',
        'export function getUserName(user: User): string {',
        '    return user.displayName;',
        '}',
    ].join('\n');
    const extracted = await extractGraphFromFile(new SweepTreeSitter(), 'src/user.ts', source, 'typescript', 1500);

    assert.ok(extracted.symbols.some(row => row.name === 'User'));
    assert.ok(extracted.symbols.some(row => row.name === 'getUserName'));
    assert.ok(extracted.refs.some(row => row.name === 'displayName' || row.name === 'User'));
});

/** Проверяет code-language fallback для Nix, если bundled WASM ещё не присутствует в тестовом окружении. */
test('extractGraphFromFile falls back for Nix code when grammar wasm is unavailable', async () => {
    const extracted = await extractGraphFromFile(new SweepTreeSitter(), 'flake.nix', '{ hello = "world"; }', 'nix', 1500);
    assert.ok(extracted.symbols.some(row => row.name === 'hello'));
});

/** Проверяет prose/unsupported no-op: graph channels не должны запускаться на документах. */
test('extractGraphFromFile returns empty result for prose language', async () => {
    const extracted = await extractGraphFromFile(new SweepTreeSitter(), 'docs/guide.md', '# Guide\ntext', 'markdown', 1500);
    assert.deepEqual(extracted, { symbols: [], refs: [] });
});
