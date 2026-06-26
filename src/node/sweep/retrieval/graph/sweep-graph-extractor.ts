import Parser from 'web-tree-sitter';
import { normalizeCrlf } from '../../../../common/text/crlf';
import { RefRow, SymbolRow } from './sweep-graph-store';
import { sweepGrammarForLanguage } from './sweep-language-registry';
import { SweepTreeSitter } from './sweep-tree-sitter-loader';

/** Минимальный размер symbol body защищает fuzzy/graph catalog от шумовых односимвольных деклараций. */
const MIN_SYMBOL_BODY_CHARS = 8;

/** Идентификатор для code graph: латиница, кириллица, цифры, _, $, дефис для Nix attrs. */
const IDENTIFIER_RE = /^[A-Za-z_$\u0410-\u044F\u0401\u0451][A-Za-z0-9_$\-\u0410-\u044F\u0401\u0451]*$/;

/** Глобальный fallback matcher деклараций для TS/Python/Nim/Nix-подобных языков. */
const FALLBACK_DECL_RE = /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|def|proc|func|method|iterator|template|macro|converter|const|let|var)\s+([A-Za-z_$\u0410-\u044F\u0401\u0451][A-Za-z0-9_$\-\u0410-\u044F\u0401\u0451]*)|(?:^|[\n{;])\s*([A-Za-z_$\u0410-\u044F\u0401\u0451][A-Za-z0-9_$\-\u0410-\u044F\u0401\u0451]*)\s*=/g;

/** Глобальный fallback matcher ссылок извлекает имена из текста без tree-sitter query layer. */
const FALLBACK_REF_RE = /[A-Za-z_$\u0410-\u044F\u0401\u0451][A-Za-z0-9_$\-\u0410-\u044F\u0401\u0451]*/g;

/** Ключевые слова исключаются из refs, чтобы fuzzy/graph не ранжировали синтаксический шум. */
const KEYWORDS = new Set([
    'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'def', 'do', 'else', 'enum', 'export', 'false', 'for', 'from', 'function', 'if', 'import', 'in', 'interface', 'let', 'macro', 'method', 'null', 'proc', 'return', 'struct', 'switch', 'template', 'this', 'throw', 'true', 'try', 'type', 'undefined', 'var', 'while', 'with', 'yield',
]);

/** Tree-sitter node.type → нормализованный kind декларации для graph ranking. */
const DECLARATION_KIND_BY_NODE: Record<string, string> = {
    function_declaration: 'function',
    function_definition: 'function',
    generator_function_declaration: 'function',
    method_definition: 'function',
    method_declaration: 'function',
    method_signature: 'function',
    proc_declaration: 'function',
    class_declaration: 'class',
    class_definition: 'class',
    interface_declaration: 'type',
    type_alias_declaration: 'type',
    enum_declaration: 'type',
    struct_item: 'type',
    struct_specifier: 'type',
    variable_declarator: 'variable',
    public_field_definition: 'variable',
    lexical_declaration: 'variable',
};

/** Node types, whose text is a usable identifier reference for graph edge collection. */
const REFERENCE_NODE_TYPES = new Set([
    'identifier',
    'property_identifier',
    'shorthand_property_identifier',
    'type_identifier',
    'field_identifier',
    'constant',
]);

export interface ExtractedFile {
    symbols: SymbolRow[];
    refs: RefRow[];
}

type SyntaxNode = Parser.SyntaxNode;

/** Парсит один code-файл и извлекает декларации/ссылки; prose/unsupported возвращает пустой graph. */
export async function extractGraphFromFile(ts: SweepTreeSitter, file: string, source: string, languageId: string, maxBodyChars: number): Promise<ExtractedFile> {
    const grammar = sweepGrammarForLanguage(languageId);
    if (!grammar) {
        return emptyExtractedFile();
    }
    const normalized = normalizeCrlf(source);
    try {
        const parser = await ts.ensureInit();
        parser.setLanguage((await ts.loadLanguage(grammar)) as Parameters<Parser['setLanguage']>[0]);
        const tree = parser.parse(normalized);
        try {
            return extractFromTree(file, normalized, tree.rootNode, maxBodyChars);
        } finally {
            tree.delete();
        }
    } catch {
        return extractWithRegexFallback(file, normalized, languageId, maxBodyChars);
    }
}

/** Создаёт пустой результат с постоянной формой объекта для unsupported/prose fast path. */
function emptyExtractedFile(): ExtractedFile {
    return { symbols: [], refs: [] };
}

/** Обходит tree-sitter AST итеративно и собирает декларации/refs без query-файлов на первом этапе. */
function extractFromTree(file: string, source: string, root: SyntaxNode, maxBodyChars: number): ExtractedFile {
    const symbols: SymbolRow[] = [];
    const refs: RefRow[] = [];
    const seenSymbols = new Set<string>();
    const seenRefs = new Set<string>();
    const stack: SyntaxNode[] = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (!node) {
            continue;
        }
        const symbol = declarationFromNode(file, source, node, maxBodyChars);
        if (symbol) {
            const key = `${symbol.name}:${symbol.file}:${symbol.startLine}:${symbol.endLine}`;
            if (!seenSymbols.has(key)) {
                seenSymbols.add(key);
                symbols.push(symbol);
            }
        }
        const ref = referenceFromNode(file, node);
        if (ref) {
            const key = `${ref.name}:${ref.file}:${ref.line}`;
            if (!seenRefs.has(key)) {
                seenRefs.add(key);
                refs.push(ref);
            }
        }
        const children = node.namedChildren;
        for (let i = children.length - 1; i >= 0; i--) {
            stack.push(children[i]);
        }
    }
    return { symbols, refs };
}

/** Извлекает декларацию из known declaration node types и generic named-node fallbacks. */
function declarationFromNode(file: string, source: string, node: SyntaxNode, maxBodyChars: number): SymbolRow | undefined {
    const kind = declarationKind(node);
    if (!kind) {
        return undefined;
    }
    const nameNode = node.childForFieldName('name') ?? firstIdentifierChild(node);
    const name = cleanIdentifier(nameNode?.text ?? '');
    if (!isUsefulIdentifier(name)) {
        return undefined;
    }
    const body = clipNodeBody(source, node, maxBodyChars);
    if (body.trim().length < MIN_SYMBOL_BODY_CHARS) {
        return undefined;
    }
    return {
        name,
        kind,
        file,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        body,
    };
}

/** Определяет normalized declaration kind по node.type с fallback для языков с похожей терминологией. */
function declarationKind(node: SyntaxNode): string | undefined {
    const direct = DECLARATION_KIND_BY_NODE[node.type];
    if (direct) {
        return direct;
    }
    if (node.type.includes('function') || node.type.includes('method') || node.type.includes('proc')) {
        return 'function';
    }
    if (node.type.includes('class')) {
        return 'class';
    }
    if (node.type.includes('type') || node.type.includes('enum') || node.type.includes('struct')) {
        return 'type';
    }
    return undefined;
}

/** Возвращает первый дочерний identifier-like node как имя декларации для грамматик без field:name. */
function firstIdentifierChild(node: SyntaxNode): SyntaxNode | undefined {
    const children = node.namedChildren;
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (REFERENCE_NODE_TYPES.has(child.type) && isUsefulIdentifier(cleanIdentifier(child.text))) {
            return child;
        }
    }
    return undefined;
}

/** Извлекает reference row из identifier-like nodes, отсекая keywords и декларационные имена. */
function referenceFromNode(file: string, node: SyntaxNode): RefRow | undefined {
    if (!REFERENCE_NODE_TYPES.has(node.type)) {
        return undefined;
    }
    const name = cleanIdentifier(node.text);
    if (!isUsefulIdentifier(name)) {
        return undefined;
    }
    return { name, file, line: node.startPosition.row + 1 };
}

/** Regex fallback поддерживает CodeGraph при отсутствии конкретной WASM-грамматики в runtime. */
function extractWithRegexFallback(file: string, source: string, languageId: string, maxBodyChars: number): ExtractedFile {
    const symbols: SymbolRow[] = [];
    const refs: RefRow[] = [];
    const lineStarts = computeLineStarts(source);
    FALLBACK_DECL_RE.lastIndex = 0;
    for (let match = FALLBACK_DECL_RE.exec(source); match; match = FALLBACK_DECL_RE.exec(source)) {
        const name = cleanIdentifier(match[1] ?? match[2] ?? '');
        if (isUsefulIdentifier(name)) {
            const line = lineForOffset(lineStarts, match.index) + 1;
            symbols.push({ name, kind: fallbackKind(match[0], languageId), file, startLine: line, endLine: line, body: clipLineAt(source, match.index, maxBodyChars) });
        }
    }
    FALLBACK_REF_RE.lastIndex = 0;
    const seenRefs = new Set<string>();
    for (let match = FALLBACK_REF_RE.exec(source); match; match = FALLBACK_REF_RE.exec(source)) {
        const name = cleanIdentifier(match[0]);
        if (isUsefulIdentifier(name)) {
            const line = lineForOffset(lineStarts, match.index) + 1;
            const key = `${name}:${line}`;
            if (!seenRefs.has(key)) {
                seenRefs.add(key);
                refs.push({ name, file, line });
            }
        }
    }
    return { symbols, refs };
}

/** Определяет fallback kind по декларационному фрагменту, чтобы graph ranking мог предпочитать функции/типы. */
function fallbackKind(fragment: string, languageId: string): string {
    const lower = `${languageId} ${fragment}`.toLowerCase();
    if (lower.includes('class')) {
        return 'class';
    }
    if (lower.includes('interface') || lower.includes('type') || lower.includes('enum') || lower.includes('struct')) {
        return 'type';
    }
    if (lower.includes('function') || lower.includes('def') || lower.includes('proc') || lower.includes('method') || lower.includes('func')) {
        return 'function';
    }
    return 'variable';
}

/** Обрезает node body до лимита, сохраняя начало символа как самый полезный контекст для NES. */
function clipNodeBody(source: string, node: SyntaxNode, maxBodyChars: number): string {
    const text = source.slice(node.startIndex, node.endIndex);
    if (text.length <= maxBodyChars) {
        return text;
    }
    return text.slice(0, maxBodyChars);
}

/** Возвращает строку вокруг fallback match как минимальный useful body без чтения файла в канале. */
function clipLineAt(source: string, offset: number, maxBodyChars: number): string {
    let start = offset;
    while (start > 0 && source.charCodeAt(start - 1) !== 10) {
        start--;
    }
    let end = offset;
    while (end < source.length && source.charCodeAt(end) !== 10) {
        end++;
    }
    const text = source.slice(start, end);
    return text.length <= maxBodyChars ? text : text.slice(0, maxBodyChars);
}

/** Нормализует raw identifier text из AST/regex, отбрасывая кавычки и property punctuation. */
function cleanIdentifier(value: string): string {
    return value.trim().replace(/^['"`]+|['"`]+$/g, '');
}

/** Проверяет identifier на синтаксическую полезность и keyword noise. */
function isUsefulIdentifier(name: string): boolean {
    return name.length > 1 && IDENTIFIER_RE.test(name) && !KEYWORDS.has(name.toLowerCase());
}

/** Строит массив offset начала строк для O(log n) line lookup в regex fallback. */
function computeLineStarts(source: string): number[] {
    const starts = [0];
    for (let i = 0; i < source.length; i++) {
        if (source.charCodeAt(i) === 10) {
            starts.push(i + 1);
        }
    }
    return starts;
}

/** Находит 0-based line number по UTF-16 offset через бинарный поиск по line starts. */
function lineForOffset(lineStarts: number[], offset: number): number {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lineStarts[mid] <= offset) {
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return Math.max(0, lo - 1);
}
