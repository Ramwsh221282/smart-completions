import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TreeSitterChunker } from '../src/node/embedding-module/chunker/tree-sitter-chunker';

// Интеграционный тест: реальный web-tree-sitter (WASM) + грамматики tree-sitter-wasms.
// Требует установленных web-tree-sitter и tree-sitter-wasms.

test('tree-sitter chunks TypeScript into top-level nodes (greedy)', async () => {
    const chunker = new TreeSitterChunker();
    const src = [
        'import { x } from "y";',
        '',
        'function foo(a: number): number {',
        '  return a + 1;',
        '}',
        '',
        'class Bar {',
        '  baz() { return 2; }',
        '}',
    ].join('\n');
    const chunks = await chunker.chunk('a.ts', src, 'typescript');
    const types = chunks.map(c => c.nodeType).join(',');
    assert.ok(chunks.length >= 2, `expected multiple chunks, got ${chunks.length} (${types})`);
    assert.ok(/function/.test(types), `expected a function chunk, got ${types}`);
    assert.ok(/class/.test(types), `expected a class chunk, got ${types}`);

    const fn = chunks.find(c => /function/.test(c.nodeType));
    assert.ok(fn, 'function chunk present');
    assert.equal(fn!.language, 'typescript');
    assert.ok(fn!.text.includes('foo'));
    assert.ok(fn!.startLine >= 1 && fn!.endLine >= fn!.startLine);
});

test('tree-sitter chunks Python', async () => {
    const chunker = new TreeSitterChunker();
    const src = ['import os', '', 'def greet(name):', '    return f"hi {name}"', '', 'class Thing:', '    pass'].join('\n');
    const chunks = await chunker.chunk('a.py', src, 'python');
    const types = chunks.map(c => c.nodeType).join(',');
    assert.ok(chunks.length >= 2, `got ${chunks.length} (${types})`);
    assert.ok(/function_definition/.test(types), `expected function_definition, got ${types}`);
});

test('tree-sitter returns [] for unsupported language', async () => {
    const chunker = new TreeSitterChunker();
    const chunks = await chunker.chunk('a.bin', 'some text', 'no-such-lang');
    assert.deepEqual(chunks, []);
});
