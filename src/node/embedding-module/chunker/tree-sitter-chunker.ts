import Parser from 'web-tree-sitter';
import { Chunk } from './chunk-meta';
import { grammarForLanguage } from './language-registry';

const MIN_CHARS = 16;

// ВАЖНО: web-tree-sitter запинен на 0.20.8 — это ABI-совместимая пара с грамматиками
// tree-sitter-wasms@0.1.13 (собраны tree-sitter-cli 0.20.x). Новые web-tree-sitter (0.25+)
// не грузят эти wasm из-за несовместимого emscripten dylink.
//
// В d.ts 0.20.8 класс Parser.Language не экспортирован из namespace, а сам объект Language
// появляется на Parser только ПОСЛЕ Parser.init(). Поэтому доступ — через каст и строго
// после инициализации (внутри loadLanguage).
type LanguageLoader = { load(input: string): Promise<unknown> };

/**
 * Семантическое чанкование кода через web-tree-sitter (WASM).
 * «Жадное» чанкование верхнего уровня: каждый top-level named-узел — один чанк,
 * без рекурсии внутрь (класс = один чанк, а не набор методов).
 */
export class TreeSitterChunker {
    private parser: Parser | undefined;
    private readonly languages = new Map<string, unknown>();
    private initialized = false;

    private async ensureInit(): Promise<void> {
        if (this.initialized) {
            return;
        }
        // locateFile помогает emscripten найти core-wasm (tree-sitter.wasm) в node_modules.
        await Parser.init({
            locateFile: (file: string) => require.resolve('web-tree-sitter/' + file),
        });
        this.parser = new Parser();
        this.initialized = true;
    }

    private async loadLanguage(grammar: string): Promise<unknown> {
        let language = this.languages.get(grammar);
        if (!language) {
            const wasmPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
            // Parser.Language доступен только после Parser.init() (вызван в ensureInit).
            const loader = (Parser as unknown as { Language: LanguageLoader }).Language;
            language = await loader.load(wasmPath);
            this.languages.set(grammar, language);
        }
        return language;
    }

    /** Вернуть чанки кода, либо [] если язык не поддерживается tree-sitter. */
    async chunk(filePath: string, source: string, languageId: string): Promise<Chunk[]> {
        const grammar = grammarForLanguage(languageId);
        if (!grammar) {
            return [];
        }
        await this.ensureInit();
        const parser = this.parser!;
        // setLanguage принимает Parser.Language; язык хранится как unknown → каст.
        parser.setLanguage((await this.loadLanguage(grammar)) as Parameters<Parser['setLanguage']>[0]);

        const tree = parser.parse(source);
        try {
            const chunks: Chunk[] = [];
            for (const node of tree.rootNode.namedChildren) {
                const text = node.text;
                if (text.trim().length < MIN_CHARS) {
                    continue;
                }
                chunks.push({
                    filePath,
                    startLine: node.startPosition.row + 1,
                    endLine: node.endPosition.row + 1,
                    language: languageId,
                    nodeType: node.type,
                    text,
                });
            }
            return chunks;
        } finally {
            tree.delete();
        }
    }
}
