// languageId (Monaco/Theia, разные написания) → имя грамматики в tree-sitter-wasms/out/.
// Наличие грамматики => режим «код»; иначе — «проза» (fallback).
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
};

/** Имя tree-sitter грамматики для languageId, либо undefined (→ проза). */
export function grammarForLanguage(languageId: string): string | undefined {
    return GRAMMAR_BY_LANGUAGE[languageId.toLowerCase()];
}

/** Есть ли tree-sitter грамматика → режим «код». */
export function isCodeLanguage(languageId: string): boolean {
    return grammarForLanguage(languageId) !== undefined;
}

// Расширение файла → languageId (для индексатора, который видит только путь на fs).
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
    // проза
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.mdx': 'markdown',
    '.txt': 'plaintext',
    '.rst': 'restructuredtext',
    '.tex': 'latex',
    '.typ': 'typst',
    '.adoc': 'asciidoc',
    '.org': 'org',
};

/** languageId по расширению (best-effort; неизвестное → plaintext → проза). */
export function languageIdForExtension(ext: string): string {
    return LANGUAGE_BY_EXT[ext.toLowerCase()] ?? 'plaintext';
}
