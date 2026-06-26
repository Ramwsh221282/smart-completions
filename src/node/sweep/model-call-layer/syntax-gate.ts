import Parser from 'web-tree-sitter';
import { grammarForLanguage } from '../../embedding-module/chunker/language-registry';

/** Loader web-tree-sitter 0.20.x доступен на Parser.Language только после Parser.init(). */
type LanguageLoader = { load(input: string): Promise<unknown> };

/** Syntax gate сравнивает дельту tree-sitter ошибок и пропускает unsupported/fallback языки. */
export class SweepSyntaxGate {
    private parser: Parser | undefined;
    private readonly languages = new Map<string, unknown>();
    private initialized = false;
    private failed = false;

    /** Возвращает прирост ошибок после правки; undefined означает что gate должен быть пропущен. */
    async errorDelta(oldWindow: string, newWindow: string, languageId: string): Promise<number | undefined> {
        const grammar = grammarForLanguage(languageId);
        if (!grammar || this.failed) {
            return undefined;
        }
        try {
            await this.ensureInit();
            const parser = this.parser;
            if (!parser) {
                return undefined;
            }
            const language = await this.loadLanguage(grammar);
            parser.setLanguage(language as Parameters<Parser['setLanguage']>[0]);
            return this.errorCount(parser, newWindow) - this.errorCount(parser, oldWindow);
        } catch {
            this.failed = true;
            return undefined;
        }
    }

    /** Инициализирует core WASM один раз, чтобы последующие проверки не платили startup cost. */
    private async ensureInit(): Promise<void> {
        if (this.initialized) {
            return;
        }
        await Parser.init({ locateFile: (file: string) => require.resolve(`web-tree-sitter/${file}`) });
        this.parser = new Parser();
        this.initialized = true;
    }

    /** Кэширует grammar WASM по имени языка, потому что загрузка языка дороже самой проверки окна. */
    private async loadLanguage(grammar: string): Promise<unknown> {
        let language = this.languages.get(grammar);
        if (!language) {
            const wasmPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
            const loader = (Parser as unknown as { Language: LanguageLoader }).Language;
            language = await loader.load(wasmPath);
            this.languages.set(grammar, language);
        }
        return language;
    }

    /** Обходит tree-sitter дерево без рекурсии и считает ERROR/MISSING узлы для regression-сравнения. */
    private errorCount(parser: Parser, source: string): number {
        const tree = parser.parse(source);
        try {
            const cursor = tree.walk();
            let count = 0;
            let done = false;
            while (!done) {
                const node = cursor.currentNode();
                if (node.type === 'ERROR' || node.isMissing()) {
                    count++;
                }
                if (cursor.gotoFirstChild()) {
                    continue;
                }
                if (cursor.gotoNextSibling()) {
                    continue;
                }
                let seekingSibling = true;
                while (seekingSibling) {
                    if (!cursor.gotoParent()) {
                        done = true;
                        break;
                    }
                    if (cursor.gotoNextSibling()) {
                        seekingSibling = false;
                    }
                }
            }
            return count;
        } finally {
            tree.delete();
        }
    }
}
