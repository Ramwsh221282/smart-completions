import * as fs from 'node:fs';
import * as path from 'node:path';

/** Monaco/Theia languageId → tree-sitter grammar name для Sweep-local CodeGraph. */
const GRAMMAR_BY_LANGUAGE: Record<string, string> = {
    typescript: 'typescript',
    typescriptreact: 'tsx',
    tsx: 'tsx',
    javascript: 'javascript',
    javascriptreact: 'javascript',
    jsx: 'javascript',
    python: 'python',
    go: 'go',
    rust: 'rust',
    c: 'c',
    cpp: 'cpp',
    'c++': 'cpp',
    csharp: 'c_sharp',
    'c#': 'c_sharp',
    java: 'java',
    ruby: 'ruby',
    php: 'php',
    bash: 'bash',
    shellscript: 'bash',
    sh: 'bash',
    zsh: 'bash',
    html: 'html',
    css: 'css',
    json: 'json',
    jsonc: 'json',
    yaml: 'yaml',
    toml: 'toml',
    lua: 'lua',
    scala: 'scala',
    swift: 'swift',
    kotlin: 'kotlin',
    vue: 'vue',
    zig: 'zig',
    dart: 'dart',
    elixir: 'elixir',
    elm: 'elm',
    ocaml: 'ocaml',
    solidity: 'solidity',
    objc: 'objc',
    'objective-c': 'objc',
    nix: 'nix',
    nim: 'nim',
};

/** Расширение файла → languageId для backend disk indexing, где Monaco languageId недоступен. */
const LANGUAGE_BY_EXT: Record<string, string> = {
    '.ts': 'typescript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.tsx': 'typescriptreact',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.hpp': 'cpp',
    '.hh': 'cpp',
    '.hxx': 'cpp',
    '.cs': 'csharp',
    '.java': 'java',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
    '.scala': 'scala',
    '.lua': 'lua',
    '.vue': 'vue',
    '.zig': 'zig',
    '.dart': 'dart',
    '.ex': 'elixir',
    '.exs': 'elixir',
    '.ml': 'ocaml',
    '.sol': 'solidity',
    '.nix': 'nix',
    '.nim': 'nim',
    '.nims': 'nim',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'bash',
    '.html': 'html',
    '.css': 'css',
    '.json': 'json',
    '.jsonc': 'jsonc',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
};

/** Возвращает grammar name для code-only Sweep graph каналов или undefined для prose/unsupported. */
export function sweepGrammarForLanguage(languageId: string): string | undefined {
    return GRAMMAR_BY_LANGUAGE[languageId.toLowerCase()];
}

/** Возвращает true только для языков, где CodeGraph/Fuzzy имеют символьный смысл. */
export function isSweepCodeLanguage(languageId: string): boolean {
    return sweepGrammarForLanguage(languageId) !== undefined;
}

/** Определяет languageId по расширению для disk indexer; неизвестное расширение становится prose no-op. */
export function sweepLanguageIdForExtension(ext: string): string {
    return LANGUAGE_BY_EXT[ext.toLowerCase()] ?? 'plaintext';
}

/** Резолвит grammar WASM: bundled Nix/Nim resources имеют приоритет над tree-sitter-wasms. */
export function resolveGrammarWasm(grammar: string): string {
    const candidates = grammarResourceCandidates(grammar);
    for (let i = 0; i < candidates.length; i++) {
        if (fs.existsSync(candidates[i])) {
            return candidates[i];
        }
    }
    return require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
}

/** Возвращает кандидаты resource-путей для runtime lib и test/build окружений. */
function grammarResourceCandidates(grammar: string): string[] {
    const file = `tree-sitter-${grammar}.wasm`;
    return [
        path.resolve(__dirname, '../../../../resources/grammars', file),
        path.resolve(process.cwd(), 'resources/grammars', file),
        path.resolve(process.cwd(), 'smart-completions/resources/grammars', file),
    ];
}
