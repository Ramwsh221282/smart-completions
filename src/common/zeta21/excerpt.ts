import type { SyntaxNode } from 'web-tree-sitter';

// Типы узлов, чьи длинные тела сворачиваются, чтобы related-эксцерпты сохраняли сигнатуры и не съедали весь context budget.
const BODY_NODE_TYPES = new Set<string>([
    'statement_block',
    'block',
    'function_body',
    'class_body',
    'declaration_list',
    'field_declaration_list',
]);

// Короткие тела оставляем как есть: иначе теряется полезная деталь без заметной экономии токенов.
const MIN_BODY_LINES_TO_COLLAPSE = 4;

/** Рендерит сигнатурный эксцерпт: длинные тела сворачиваются в `...`, а внешняя форма файла остаётся читаемой для модели. */
export function renderExcerpt(source: string, root: SyntaxNode | null): string {
    if (!root) {
        return source;
    }
    const collapses: Array<{ start: number; end: number }> = [];
    collectCollapses(root, collapses);
    if (collapses.length === 0) {
        return source;
    }
    collapses.sort((a, b) => a.start - b.start);
    const parts: string[] = [];
    let pos = 0;
    for (let i = 0; i < collapses.length; i++) {
        const collapse = collapses[i];
        if (collapse.start < pos) {
            continue;
        }
        parts.push(source.slice(pos, collapse.start));
        parts.push('...');
        pos = collapse.end;
    }
    parts.push(source.slice(pos));
    return parts.join('');
}

function collectCollapses(node: SyntaxNode, out: Array<{ start: number; end: number }>): void {
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child === null) {
            continue;
        }
        if (BODY_NODE_TYPES.has(child.type) && bodyLineSpan(child) >= MIN_BODY_LINES_TO_COLLAPSE) {
            const innerStart = child.startIndex + 1;
            const innerEnd = child.endIndex - 1;
            if (innerEnd > innerStart) {
                out.push({ start: innerStart, end: innerEnd });
            }
            continue;
        }
        collectCollapses(child, out);
    }
}

function bodyLineSpan(node: SyntaxNode): number {
    return node.endPosition.row - node.startPosition.row + 1;
}
