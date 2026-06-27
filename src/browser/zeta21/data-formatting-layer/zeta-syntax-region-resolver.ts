import type * as monaco from '@theia/monaco-editor-core';
import Parser from 'web-tree-sitter';
import type { DiagnosticDTO } from '../../../common/editor-dto';
import type { RegionBounds } from '../../../common/zeta21/markers';
import { ZetaLogger } from '../../../common/zeta21/logger';

// web-tree-sitter 0.20.x публикует runtime loader на Parser.Language только после Parser.init().
type LanguageLoader = { load(input: string | Uint8Array): Promise<unknown> };

// Grammar map ограничен браузерно подготовленными wasm-ресурсами; остальные языки честно деградируют в line fallback.
const GRAMMAR_BY_LANGUAGE: Record<string, string> = {
    typescript: 'typescript',
    typescriptreact: 'tsx',
    tsx: 'tsx',
    javascript: 'javascript',
    javascriptreact: 'javascript',
    jsx: 'javascript',
};

// Многострочное окно не должно захватывать весь файл: модель выигрывает от локального блока/функции, а не от сотен строк кода.
const MAX_WINDOW_LINES = 24;

// Диагностические вторичные регионы ограничены маленьким числом, чтобы multi-region оставался точечным, а не превращался в whole-file rewrite.
const MAX_SECONDARY_REGIONS = 3;

// Эти типы обычно дают полезный edit window шире строки курсора и хорошо совпадают с естественными границами next-edit у Zeta.
const EXPANDABLE_WINDOW_TYPES = new Set<string>([
    'statement_block',
    'function_body',
    'function_declaration',
    'function_expression',
    'method_definition',
    'arrow_function',
    'if_statement',
    'for_statement',
    'for_in_statement',
    'for_of_statement',
    'while_statement',
    'do_statement',
    'switch_statement',
    'try_statement',
    'catch_clause',
]);

// Узлы editable-region должны быть уже осмысленными кусками кода, чтобы маркеры чаще стояли на границах строк/statement'ов, а не в середине идентификатора.
const EDITABLE_REGION_TYPES = new Set<string>([
    'expression_statement',
    'return_statement',
    'throw_statement',
    'if_statement',
    'for_statement',
    'for_in_statement',
    'for_of_statement',
    'while_statement',
    'do_statement',
    'switch_statement',
    'try_statement',
    'catch_clause',
    'break_statement',
    'continue_statement',
    'lexical_declaration',
    'variable_declaration',
    'variable_declarator',
    'assignment_expression',
    'call_expression',
    'new_expression',
    'await_expression',
    'binary_expression',
    'conditional_expression',
    'function_declaration',
    'function_expression',
    'method_definition',
    'arrow_function',
    'class_declaration',
    'interface_declaration',
    'type_alias_declaration',
    'import_statement',
    'export_statement',
]);

// Логгер syntax resolver нужен для отладки выбора окна/регионов и для диагностики недоступных wasm-грамматик на фронте.
const LOG = new ZetaLogger('browser:data-formatting:syntax-region-resolver');

// browser-resources копируются build-скриптом в lib/resources, поэтому runtime может грузить wasm по этим относительным URL.
const TREE_SITTER_CORE_RESOURCE = 'resources/tree-sitter/tree-sitter.wasm';

const GRAMMAR_RESOURCE_BY_ID: Record<string, string> = {
    typescript: 'resources/grammars/tree-sitter-typescript.wasm',
    tsx: 'resources/grammars/tree-sitter-tsx.wasm',
    javascript: 'resources/grammars/tree-sitter-javascript.wasm',
};

// Resolver result уже даёт покрывающее syntax window и editable bounds внутри него, чтобы request builder не дублировал AST-логику.
export interface ResolvedSyntaxWindow {
    windowText: string;
    windowStart: { line: number; character: number };
    cursorOffset: number;
    prefixText: string;
    suffixText: string;
    syntacticBounds: RegionBounds[] | null;
}

/**
 * Browser-side tree-sitter resolver превращает курсор в AST-driven edit window и один или несколько editable region bounds.
 * Это активирует синтаксическое расширение и multi-region, которые уже поддерживаются остальным zeta21-пайплайном.
 */
export class ZetaSyntaxRegionResolver {
    private parser: Parser | undefined;
    private initialized = false;
    private readonly languages = new Map<string, unknown>();

    /** Возвращает AST-driven window и region bounds для code-mode; при недоступном parser/grammar честно деградирует в undefined. */
    async resolve(model: monaco.editor.ITextModel, position: monaco.Position, diagnostics: DiagnosticDTO[]): Promise<ResolvedSyntaxWindow | undefined> {
        const grammar = grammarForLanguage(model.getLanguageId());
        if (!grammar || typeof window === 'undefined') {
            return undefined;
        }
        try {
            return this.resolveWindow(model, position, diagnostics, grammar);
        } catch (error) {
            LOG.warn('Zeta syntax region resolution failed', { uri: model.uri.toString(), languageId: model.getLanguageId(), error: error instanceof Error ? error.message : String(error) });
            return undefined;
        }
    }

    private async resolveWindow(
        model: monaco.editor.ITextModel,
        position: monaco.Position,
        diagnostics: DiagnosticDTO[],
        grammar: string,
    ): Promise<ResolvedSyntaxWindow | undefined> {
        const parser = await this.ensureParser(grammar);
        const source = model.getValue();
        const tree = parser.parse(source);
        const cursorOffset = model.getOffsetAt(position);
        const cursorNode = tree.rootNode.namedDescendantForIndex(cursorOffset, cursorOffset);
        const windowNode = selectWindowNode(cursorNode);
        const windowBounds = expandNodeToWholeLines(source, windowNode);
        const primaryNode = selectEditableNode(cursorNode, windowNode);
        const regionBounds = this.resolveRegionBounds(source, tree.rootNode, model, diagnostics, windowNode, primaryNode, windowBounds);
        if (regionBounds.length === 0) {
            return undefined;
        }
        return this.buildResolvedWindow(model, grammar, source, cursorOffset, windowBounds, regionBounds);
    }

    /** Инициализирует parser core один раз и выставляет выбранную grammar перед очередным parse. */
    private async ensureParser(grammar: string): Promise<Parser> {
        if (!this.initialized) {
            await Parser.init({ locateFile: () => resourceUrl(TREE_SITTER_CORE_RESOURCE) });
            this.parser = new Parser();
            this.initialized = true;
        }
        if (!this.parser) {
            this.parser = new Parser();
        }
        this.parser.setLanguage((await this.loadLanguage(grammar)) as Parameters<Parser['setLanguage']>[0]);
        return this.parser;
    }

    /** Загружает grammar wasm из browser resources и кэширует Language object между trigger-вызовами. */
    private async loadLanguage(grammar: string): Promise<unknown> {
        let language = this.languages.get(grammar);
        if (!language) {
            const loader = (Parser as unknown as { Language: LanguageLoader }).Language;
            const bytes = await fetchWasmBytes(resourceUrl(GRAMMAR_RESOURCE_BY_ID[grammar]));
            language = await loader.load(bytes);
            this.languages.set(grammar, language);
        }
        return language;
    }

    private resolveRegionBounds(
        source: string,
        root: Parser.SyntaxNode,
        model: monaco.editor.ITextModel,
        diagnostics: DiagnosticDTO[],
        windowNode: Parser.SyntaxNode,
        primaryNode: Parser.SyntaxNode,
        windowBounds: RegionBounds,
    ): RegionBounds[] {
        return normalizeRegionBounds([
            expandNodeToWholeLines(source, primaryNode),
            ...collectSecondaryRegionBounds(source, root, model, diagnostics, windowNode, primaryNode),
        ], windowBounds);
    }

    private buildResolvedWindow(
        model: monaco.editor.ITextModel,
        grammar: string,
        source: string,
        cursorOffset: number,
        windowBounds: RegionBounds,
        regionBounds: RegionBounds[],
    ): ResolvedSyntaxWindow {
        const windowText = source.slice(windowBounds.start, windowBounds.end);
        const relativeBounds = new Array<RegionBounds>(regionBounds.length);
        for (let i = 0; i < regionBounds.length; i++) {
            relativeBounds[i] = {
                start: regionBounds[i].start - windowBounds.start,
                end: regionBounds[i].end - windowBounds.start,
            };
        }
        const windowStart = model.getPositionAt(windowBounds.start);
        LOG.info('Zeta syntax window resolved', {
            uri: model.uri.toString(),
            grammar,
            windowChars: windowText.length,
            regions: relativeBounds.length,
            windowStartLine: windowStart.lineNumber - 1,
        });
        return {
            windowText,
            windowStart: { line: windowStart.lineNumber - 1, character: windowStart.column - 1 },
            cursorOffset: cursorOffset - windowBounds.start,
            prefixText: source.slice(0, windowBounds.start),
            suffixText: source.slice(windowBounds.end),
            syntacticBounds: relativeBounds,
        };
    }
}

function grammarForLanguage(languageId: string): string | undefined {
    return GRAMMAR_BY_LANGUAGE[languageId.toLowerCase()];
}

function selectWindowNode(node: Parser.SyntaxNode): Parser.SyntaxNode {
    let current: Parser.SyntaxNode | null = node;
    while (current) {
        if (isExpandableWindowNode(current) && lineSpan(current) <= MAX_WINDOW_LINES) {
            return current;
        }
        current = current.parent;
    }
    return node;
}

function selectEditableNode(node: Parser.SyntaxNode, windowNode: Parser.SyntaxNode): Parser.SyntaxNode {
    let current: Parser.SyntaxNode | null = node;
    while (current && current !== windowNode.parent) {
        if (isEditableRegionNode(current)) {
            return current;
        }
        current = current.parent;
    }
    return windowNode;
}

function collectSecondaryRegionBounds(source: string, root: Parser.SyntaxNode, model: monaco.editor.ITextModel, diagnostics: DiagnosticDTO[], windowNode: Parser.SyntaxNode, primaryNode: Parser.SyntaxNode): RegionBounds[] {
    if (diagnostics.length === 0) {
        return [];
    }
    const out: RegionBounds[] = [];
    const primaryBounds = expandNodeToWholeLines(source, primaryNode);
    const windowLineStart = windowNode.startPosition.row;
    const windowLineEnd = windowNode.endPosition.row;
    for (let i = 0; i < diagnostics.length && out.length < MAX_SECONDARY_REGIONS; i++) {
        const diagnostic = diagnostics[i];
        const line = diagnostic.range.start.line;
        if (line < windowLineStart || line > windowLineEnd) {
            continue;
        }
        if (line >= primaryNode.startPosition.row && line <= primaryNode.endPosition.row) {
            continue;
        }
        const offset = model.getOffsetAt({ lineNumber: line + 1, column: diagnostic.range.start.character + 1 });
        const node = root.namedDescendantForIndex(offset, offset);
        const candidate = selectEditableNode(node, windowNode);
        const bounds = expandNodeToWholeLines(source, candidate);
        if (!overlaps(bounds, primaryBounds)) {
            out.push(bounds);
        }
    }
    return out;
}

function isExpandableWindowNode(node: Parser.SyntaxNode): boolean {
    return lineSpan(node) > 1 && (EXPANDABLE_WINDOW_TYPES.has(node.type) || node.type.endsWith('_statement'));
}

function isEditableRegionNode(node: Parser.SyntaxNode): boolean {
    return EDITABLE_REGION_TYPES.has(node.type) || node.type.endsWith('_statement') || node.type.endsWith('_declaration');
}

function lineSpan(node: Parser.SyntaxNode): number {
    return node.endPosition.row - node.startPosition.row + 1;
}

function expandNodeToWholeLines(source: string, node: Parser.SyntaxNode): RegionBounds {
    let start = node.startIndex;
    while (start > 0 && source.charCodeAt(start - 1) !== 10) {
        start--;
    }
    let end = node.endIndex;
    while (end < source.length && source.charCodeAt(end) !== 10) {
        end++;
    }
    return { start, end };
}

function normalizeRegionBounds(bounds: RegionBounds[], windowBounds: RegionBounds): RegionBounds[] {
    if (bounds.length === 0) {
        return [];
    }
    const normalized = new Array<RegionBounds>(bounds.length);
    for (let i = 0; i < bounds.length; i++) {
        const start = Math.max(windowBounds.start, Math.min(bounds[i].start, windowBounds.end));
        const end = Math.max(start, Math.min(bounds[i].end, windowBounds.end));
        normalized[i] = { start, end };
    }
    normalized.sort((a, b) => a.start - b.start || a.end - b.end);
    const out: RegionBounds[] = [normalized[0]];
    for (let i = 1; i < normalized.length; i++) {
        const current = normalized[i];
        const previous = out[out.length - 1];
        if (current.start <= previous.end) {
            if (current.end > previous.end) {
                previous.end = current.end;
            }
            continue;
        }
        out.push(current);
    }
    return out;
}

function overlaps(left: RegionBounds, right: RegionBounds): boolean {
    return left.start < right.end && right.start < left.end;
}

function resourceUrl(relativePath: string): string {
    return new URL(relativePath, window.location.href).toString();
}

async function fetchWasmBytes(url: string): Promise<Uint8Array> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`tree-sitter resource fetch failed: ${response.status} ${response.statusText}`);
    }
    return new Uint8Array(await response.arrayBuffer());
}
