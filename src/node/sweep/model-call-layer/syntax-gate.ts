import Parser from 'web-tree-sitter';
import { LRUCache } from 'lru-cache';
import { grammarForLanguage } from '../../embedding-module/chunker/language-registry';
import { md5 } from '../../util/hash';

/** Размер syntax cache ограничивает память и сохраняет повторяющиеся окна между predict-вызовами. */
const SYNTAX_ERROR_CACHE_MAX = 512;

/** Loader web-tree-sitter 0.20.x доступен на Parser.Language только после Parser.init(). */
type LanguageLoader = { load(input: string): Promise<unknown> };

/** Syntax gate сравнивает дельту tree-sitter ошибок и пропускает unsupported/fallback языки. */
export class SweepSyntaxGate {
    private parser: Parser | undefined;
    private readonly languages = new Map<string, unknown>();
    private readonly errorCache = new LRUCache<string, number>({ max: SYNTAX_ERROR_CACHE_MAX });
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
            return this.errorCount(parser, grammar, newWindow) - this.errorCount(parser, grammar, oldWindow);
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

    /** Возвращает cached или вычисленное число ERROR/MISSING узлов для окна кода. */
    private errorCount(parser: Parser, grammar: string, source: string): number {
        const key = `${grammar}:${md5(source)}`;
        const cached = this.errorCache.get(key);
        if (cached !== undefined) {
            return cached;
        }
        const counted = this.computeErrorCount(parser, source);
        this.errorCache.set(key, counted);
        return counted;
    }

    /** Обходит tree-sitter дерево без рекурсии и считает ERROR/MISSING узлы для regression-сравнения. */
    private computeErrorCount(parser: Parser, source: string): number {
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
