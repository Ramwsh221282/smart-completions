import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SyntaxNode } from 'web-tree-sitter';
import { renderExcerpt } from '../src/common/zeta21/excerpt';

test('renderExcerpt collapses long bodies into ellipsis', () => {
    const source = 'function demo() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n}\n';
    const bodyStart = source.indexOf('{');
    const bodyEnd = source.lastIndexOf('}') + 1;
    const tree = node('program', 0, source.length, 0, 5, [
        node('statement_block', bodyStart, bodyEnd, 0, 5),
    ]);

    const excerpt = renderExcerpt(source, tree);

    assert.ok(excerpt.includes('...'));
    assert.ok(excerpt.length < source.length);
});

test('renderExcerpt keeps short bodies unchanged and falls back to source without a tree', () => {
    const shortSource = 'function demo() {\n  return 1;\n}\n';
    const shortTree = node('program', 0, shortSource.length, 0, 2, [
        node('statement_block', shortSource.indexOf('{'), shortSource.lastIndexOf('}') + 1, 0, 2),
    ]);

    assert.equal(renderExcerpt(shortSource, shortTree), shortSource);
    assert.equal(renderExcerpt(shortSource, null), shortSource);
});

function node(type: string, startIndex: number, endIndex: number, startRow: number, endRow: number, children: SyntaxNode[] = []): SyntaxNode {
    return {
        type,
        startIndex,
        endIndex,
        startPosition: { row: startRow, column: 0 },
        endPosition: { row: endRow, column: 0 },
        childCount: children.length,
        child(index: number): SyntaxNode | null {
            return children[index] ?? null;
        },
    } as unknown as SyntaxNode;
}
