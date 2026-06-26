import * as fs from 'fs';
import * as path from 'path';
import ignore, { Ignore } from 'ignore';

/** Каталоги, всегда пропускаемые при индексации (гигиена индекса). */
export const SKIP_DIRS = [
    '.git',
    'node_modules',
    '.venv',
    'venv',
    '__pycache__',
    '.next',
    '.nuxt',
    '.cache',
    '.gradle',
    '.turbo',
    '.parcel-cache',
    'dist',
    'build',
    'target',
    'coverage',
    'out',
    'vendor',
];

/** Индексируемые расширения (код + конфиги + документы). */
export const INDEXABLE_EXTENSIONS = new Set<string>([
    '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.go', '.rs', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx',
    '.cs', '.java', '.kt', '.kts', '.rb', '.php', '.swift', '.scala', '.lua',
    '.vue', '.svelte', '.sql', '.sh', '.bash', '.zsh', '.zig', '.dart', '.ex', '.exs',
    '.ml', '.sol',
    '.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.html', '.css', '.scss', '.less',
    '.md', '.markdown', '.mdx', '.txt', '.rst', '.tex', '.typ', '.adoc', '.org',
]);

export const MAX_FILE_BYTES = 1_000_000;

/**
 * Предикат игнорирования: skip-dirs + содержимое корневого .gitignore (через lib `ignore`).
 * Пути — POSIX-относительные от корня воркспейса.
 */
export class IndexIgnore {
    private readonly ig: Ignore;

    constructor(gitignoreContents: string[] = []) {
        this.ig = ignore();
        this.ig.add(SKIP_DIRS);
        for (const content of gitignoreContents) {
            this.ig.add(content);
        }
    }

    static async load(rootPath: string): Promise<IndexIgnore> {
        const contents: string[] = [];
        try {
            contents.push(await fs.promises.readFile(path.join(rootPath, '.gitignore'), 'utf8'));
        } catch {
            /* .gitignore может отсутствовать */
        }
        return new IndexIgnore(contents);
    }

    /** relPath — относительный POSIX-путь (не пустой, не абсолютный). */
    isIgnored(relPath: string): boolean {
        if (!relPath || relPath === '.' || relPath.startsWith('/')) {
            return false;
        }
        return this.ig.ignores(relPath);
    }

    isIndexableFile(relPath: string): boolean {
        return INDEXABLE_EXTENSIONS.has(path.extname(relPath).toLowerCase());
    }
}
