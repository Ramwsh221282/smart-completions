import Parser from 'web-tree-sitter';
import { resolveGrammarWasm } from './sweep-language-registry';

/** Loader type отражает runtime Parser.Language API, который появляется после Parser.init(). */
type LanguageLoader = { load(input: string): Promise<unknown> };

/** Sweep-local tree-sitter loader кэширует parser core и grammar WASM независимо от embedding-module. */
export class SweepTreeSitter {
    private parser: Parser | undefined;
    private initialized = false;
    private readonly languages = new Map<string, unknown>();

    /** Инициализирует web-tree-sitter core один раз и возвращает переиспользуемый parser. */
    async ensureInit(): Promise<Parser> {
        if (!this.initialized) {
            await Parser.init({ locateFile: (file: string) => require.resolve(`web-tree-sitter/${file}`) });
            this.parser = new Parser();
            this.initialized = true;
        }
        if (!this.parser) {
            this.parser = new Parser();
        }
        return this.parser;
    }

    /** Загружает grammar WASM через bundled-resource-first resolver и кэширует Language object. */
    async loadLanguage(grammar: string): Promise<unknown> {
        let language = this.languages.get(grammar);
        if (!language) {
            const loader = (Parser as unknown as { Language: LanguageLoader }).Language;
            language = await loader.load(resolveGrammarWasm(grammar));
            this.languages.set(grammar, language);
        }
        return language;
    }
}
