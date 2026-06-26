import { splitLines } from '../text/crlf';
import { SweepLogger } from './logger';

// Логгер модуля outline; нужен для диагностики какой символ был помечен курсором и сколько символов в дереве.
const LOG = new SweepLogger('common:outline');

// Символ дерева структуры файла; используется как единица outline-псевдофайла в Sweep-промпте.
export interface OutlineSymbol {
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
    startChar?: number;
    endChar?: number;
    children?: OutlineSymbol[];
}

// Инклюзивный диапазон строк; используется для выбора окна редактирования вокруг символа содержащего курсор.
export interface LineRange {
    startLine: number;
    endLine: number;
}

/**
 * Форматирует строку-заголовок диапазона символа для outline псевдофайла;
 * нужен чтобы модель могла сопоставить символ с реальными строками файла.
 */
function header(s: OutlineSymbol): string {
    const a = s.startChar !== undefined ? `${s.startLine + 1}:${s.startChar}` : `${s.startLine + 1}`;
    const b = s.endChar !== undefined ? `${s.endLine + 1}:${s.endChar}` : `${s.endLine + 1}`;
    return `[${a}-${b}]`;
}

/**
 * Проверяет что символ содержит указанную строку; нужен чтобы найти глубочайший
 * символ охватывающий позицию курсора для маркера `<-- cursor`.
 */
function contains(s: OutlineSymbol, line: number): boolean {
    return line >= s.startLine && line <= s.endLine;
}

/**
 * Ищет наиболее вложенный символ содержащий курсор; нужен чтобы маркер `<-- cursor`
 * в outline псевдофайле указывал на точный метод или функцию а не на весь класс.
 */
export function deepestContaining(symbols: OutlineSymbol[], cursorLine: number): OutlineSymbol | undefined {
    let best: OutlineSymbol | undefined;
    const walk = (list: OutlineSymbol[]): void => {
        for (const s of list) {
            if (contains(s, cursorLine)) {
                best = s;
                if (s.children?.length) {
                    walk(s.children);
                }
            }
        }
    };
    walk(symbols);
    if (process.env.NODE_ENV === 'development') {
        LOG.debug('deepest Sweep outline symbol selected', { cursorLine, symbol: best?.name });
    }
    return best;
}

/**
 * Строит компактный текст outline псевдофайла с маркером `<-- cursor` на глубочайшем символе;
 * нужен для зоны B Sweep-промпта чтобы модель понимала структуру файла и место курсора.
 */
export function formatOutline(symbols: OutlineSymbol[], cursorLine: number): string {
    const marked = deepestContaining(symbols, cursorLine);
    const lines: string[] = [];
    const walk = (list: OutlineSymbol[], depth: number): void => {
        for (const s of list) {
            const indent = '  '.repeat(depth);
            const cursor = s === marked ? ' <-- cursor' : '';
            lines.push(`${indent}${s.name} ${header(s)}${cursor}`);
            if (s.children?.length) {
                walk(s.children, depth + 1);
            }
        }
    };
    walk(symbols, 0);
    const outline = lines.join('\n');
    LOG.info('Sweep outline formatted', { symbols: symbols.length, cursorLine, chars: outline.length, marked: marked?.name });
    return outline;
}

/**
 * Выбирает наибольший символ охватывающий курсор который помещается в окно maxLines строк;
 * нужен чтобы editorWindow захватывал семантически завершённый блок кода а не обрывался посередине.
 */
export function selectEnclosingRange(symbols: OutlineSymbol[], cursorLine: number, maxLines: number): LineRange | undefined {
    let best: OutlineSymbol | undefined;
    const walk = (list: OutlineSymbol[]): void => {
        for (const s of list) {
            if (contains(s, cursorLine)) {
                const size = s.endLine - s.startLine + 1;
                if (size <= maxLines && (!best || size > best.endLine - best.startLine + 1)) {
                    best = s;
                }
                if (s.children?.length) {
                    walk(s.children);
                }
            }
        }
    };
    walk(symbols);
    const range = best ? { startLine: best.startLine, endLine: best.endLine } : undefined;
    if (process.env.NODE_ENV === 'development') {
        LOG.debug('Sweep enclosing range selected', { cursorLine, maxLines, range });
    }
    return range;
}

// Распознаёт объявления классов, интерфейсов и функций верхнего уровня для fallback-эвристики.
const BRACE_DECL = /^(\s*)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|enum|namespace|module|function)\s+([A-Za-z_$][\w$]*)/;
// Распознаёт объявления методов внутри классов для fallback-эвристики.
const METHOD_DECL = /^(\s*)(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{/;

/**
 * Строит дерево символов регулярными выражениями когда LSP-провайдер недоступен;
 * нужен чтобы outline не был пустым в файлах без языкового сервера.
 */
export function extractCodeSymbolsHeuristic(text: string): OutlineSymbol[] {
    const lines = splitLines(text);
    const roots: OutlineSymbol[] = [];
    const stack: Array<{ symbol: OutlineSymbol; depth: number }> = [];
    let depth = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const topDecl = BRACE_DECL.exec(line);
        const methodDecl = !topDecl ? METHOD_DECL.exec(line) : null;
        if (topDecl || methodDecl) {
            const kind = topDecl ? topDecl[1] : 'method';
            const name = topDecl ? topDecl[3] : methodDecl?.[2];
            if (!name) {
                continue;
            }
            if (!(kind === 'method' && (name === 'if' || name === 'for' || name === 'while' || name === 'switch' || name === 'catch'))) {
                const symbol: OutlineSymbol = { name, kind, startLine: i, endLine: i };
                const parent = stack[stack.length - 1];
                if (parent) {
                    if (!parent.symbol.children) {
                        parent.symbol.children = [];
                    }
                    parent.symbol.children.push(symbol);
                } else {
                    roots.push(symbol);
                }
                if (line.includes('{')) {
                    stack.push({ symbol, depth });
                }
            }
        }
        // charCodeAt избегает создания итератора и боксинга символов на каждой итерации (rule 11).
        for (let j = 0, len = line.length; j < len; j++) {
            const code = line.charCodeAt(j);
            if (code === 123 /* { */) {
                depth++;
            } else if (code === 125 /* } */) {
                depth--;
                const top = stack[stack.length - 1];
                if (top && depth === top.depth) {
                    top.symbol.endLine = i;
                    stack.pop();
                }
            }
        }
    }
    for (const open of stack) {
        open.symbol.endLine = lines.length - 1;
    }
    LOG.info('Sweep heuristic outline extracted', { roots: roots.length, lines: lines.length });
    return roots;
}
