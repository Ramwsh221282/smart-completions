import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ignore, { type Ignore } from 'ignore';
import { injectable } from '@theia/core/shared/inversify';
import { normalizeCrlf } from '../../../../common/text/crlf';
import { md5 } from '../../../util/hash';
import { SweepFuzzyChannel } from '../fuzzy/sweep-fuzzy-channel';
import { extractGraphFromFile } from './sweep-graph-extractor';
import { BetterSqlite3GraphStore, SweepGraphStore } from './sweep-graph-store';
import { sweepLanguageIdForExtension } from './sweep-language-registry';
import { SweepTreeSitter } from './sweep-tree-sitter-loader';

/** Максимальный body символа хранится в SQLite, чтобы channels не читали файлы на hot path. */
const MAX_BODY_CHARS = 1500;

/** Максимальный размер файла для graph parsing совпадает по порядку с embedding hygiene. */
const MAX_GRAPH_FILE_BYTES = 1_000_000;

/** Каталоги, которые CodeGraph всегда пропускает при full index. */
const GRAPH_SKIP_DIRS = ['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.cache', '.gradle', '.turbo', '.parcel-cache', 'dist', 'build', 'target', 'coverage', 'out', 'vendor'];

/** CodeGraph индексирует только code extensions, потому что graph/fuzzy channels code-only. */
const GRAPH_INDEXABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.cs', '.java', '.kt', '.kts', '.rb', '.php', '.swift', '.scala', '.lua', '.vue', '.zig', '.dart', '.ex', '.exs', '.ml', '.sol', '.nix', '.nim', '.nims', '.sh', '.bash', '.zsh', '.html', '.css', '.json', '.jsonc', '.yaml', '.yml', '.toml']);

interface WorkspaceFileRef {
    abs: string;
    rel: string;
}

/** Sweep CodeGraph indexer владеет SQLite graph и инкрементальным обновлением fuzzy catalog. */
@injectable()
export class SweepGraphIndexer {
    private store: SweepGraphStore | undefined;
    private roots: string[] = [];
    private readonly ts = new SweepTreeSitter();
    private readonly fuzzy: SweepFuzzyChannel;

    /** Fuzzy catalog обновляется рядом с graph reindex, чтобы не делать отдельный обход БД. */
    constructor(fuzzy: SweepFuzzyChannel) {
        this.fuzzy = fuzzy;
    }

    /** Конфигурирует graph storage для workspace roots; full index выполняется только при новой БД. */
    async configure(roots: string[], cacheRoot: string, enabled: boolean): Promise<void> {
        if (!enabled) {
            this.dispose();
            return;
        }
        this.dispose();
        this.roots = roots;
        const workspaceDir = path.join(cacheRoot, md5(roots.join('|') || 'default'));
        await fs.promises.mkdir(workspaceDir, { recursive: true });
        const dbPath = path.join(workspaceDir, 'sweep-graph.sqlite');
        const fresh = !fs.existsSync(dbPath);
        this.store = new BetterSqlite3GraphStore(dbPath);
        if (fresh) {
            await this.fullIndex();
        } else {
            this.fuzzy.rebuild(this.store.allSymbolNames());
        }
    }

    /** Инкрементально переиндексирует один файл: live source имеет приоритет над чтением с диска. */
    async reindexFile(uri: string, source?: string, languageId?: string): Promise<void> {
        const store = this.store;
        if (!store) {
            return;
        }
        const file = this.workspaceFileForUri(uri);
        if (!file) {
            return;
        }
        store.deleteFile(file.rel);
        let text = source;
        if (text === undefined) {
            try {
                text = normalizeCrlf(await fs.promises.readFile(file.abs, 'utf8'));
            } catch {
                this.fuzzy.removeFile(file.rel);
                return;
            }
        }
        const lang = languageId ?? sweepLanguageIdForExtension(path.extname(file.abs));
        const extracted = await extractGraphFromFile(this.ts, file.rel, text, lang, MAX_BODY_CHARS);
        store.insertSymbols(extracted.symbols);
        store.insertRefs(extracted.refs);
        this.fuzzy.updateFile(file.rel, extracted.symbols);
    }

    /** Возвращает активный graph store для hot-path channels или undefined до configure. */
    getStore(): SweepGraphStore | undefined {
        return this.store;
    }

    /** Закрывает graph store и очищает fuzzy catalog при отключении каналов или смене workspace. */
    dispose(): void {
        this.store?.dispose();
        this.store = undefined;
        this.fuzzy.rebuild([]);
    }

    /** Выполняет полный disk index с локальной gitignore-гигиеной. */
    private async fullIndex(): Promise<void> {
        const store = this.store;
        if (!store) {
            return;
        }
        store.reset();
        const files = await this.collectFiles();
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            let content = '';
            try {
                content = normalizeCrlf(await fs.promises.readFile(file.abs, 'utf8'));
            } catch {
                continue;
            }
            const lang = sweepLanguageIdForExtension(path.extname(file.abs));
            const extracted = await extractGraphFromFile(this.ts, file.rel, content, lang, MAX_BODY_CHARS);
            store.insertSymbols(extracted.symbols);
            store.insertRefs(extracted.refs);
        }
        this.fuzzy.rebuild(store.allSymbolNames());
    }

    /** Собирает индексируемые code-файлы по roots с учётом skip dirs и root .gitignore. */
    private async collectFiles(): Promise<WorkspaceFileRef[]> {
        const out: WorkspaceFileRef[] = [];
        for (let i = 0; i < this.roots.length; i++) {
            const root = this.roots[i];
            const ig = await GraphIndexIgnore.load(root);
            await this.walk(root, root, ig, out);
        }
        return out;
    }

    /** Обходит директорию итеративно-рекурсивным async DFS, пропуская неиндексируемые пути. */
    private async walk(dir: string, root: string, ig: GraphIndexIgnore, out: WorkspaceFileRef[]): Promise<void> {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const abs = path.join(dir, entry.name);
            const rel = toPosix(path.relative(root, abs));
            if (entry.isDirectory()) {
                if (!ig.isIgnored(rel)) {
                    await this.walk(abs, root, ig, out);
                }
            } else if (entry.isFile() && !ig.isIgnored(rel) && ig.isIndexableFile(rel)) {
                const stat = await safeStat(abs);
                if (stat && stat.size <= MAX_GRAPH_FILE_BYTES) {
                    out.push({ abs, rel });
                }
            }
        }
    }

    /** Конвертирует URI в workspace-relative graph key; outside-workspace файлы graph не индексирует. */
    private workspaceFileForUri(uri: string): WorkspaceFileRef | undefined {
        const abs = uriToFsPath(uri);
        for (let i = 0; i < this.roots.length; i++) {
            const root = this.roots[i];
            const rel = path.relative(root, abs);
            if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
                return { abs, rel: toPosix(rel) };
            }
            if (abs === root) {
                return undefined;
            }
        }
        return undefined;
    }
}

/** Локальный ignore helper держит CodeGraph автономным от embedding-module internals. */
class GraphIndexIgnore {
    private readonly ig: Ignore;

    /** Создаёт ignore matcher из skip dirs и root .gitignore contents. */
    constructor(gitignoreContents: string[] = []) {
        this.ig = ignore();
        this.ig.add(GRAPH_SKIP_DIRS);
        for (let i = 0; i < gitignoreContents.length; i++) {
            this.ig.add(gitignoreContents[i]);
        }
    }

    /** Загружает root .gitignore best-effort для full index hygiene. */
    static async load(rootPath: string): Promise<GraphIndexIgnore> {
        const contents: string[] = [];
        try {
            contents.push(await fs.promises.readFile(path.join(rootPath, '.gitignore'), 'utf8'));
        } catch {
            return new GraphIndexIgnore(contents);
        }
        return new GraphIndexIgnore(contents);
    }

    /** Проверяет относительный POSIX path на skip-dir или .gitignore match. */
    isIgnored(relPath: string): boolean {
        if (!relPath || relPath === '.' || relPath.startsWith('/')) {
            return false;
        }
        return this.ig.ignores(relPath);
    }

    /** Проверяет code-only extension allowlist для graph indexing. */
    isIndexableFile(relPath: string): boolean {
        return GRAPH_INDEXABLE_EXTENSIONS.has(path.extname(relPath).toLowerCase());
    }
}

/** Нормализует filesystem path в POSIX form для prompt-compatible graph keys. */
function toPosix(value: string): string {
    return value.split(path.sep).join('/');
}

/** Конвертирует Monaco/Theia file URI в filesystem path, tolerate уже-normalized paths. */
function uriToFsPath(uri: string): string {
    try {
        return uri.startsWith('file:') ? fileURLToPath(uri) : uri;
    } catch {
        return uri;
    }
}

/** Безопасно читает stat для full index, чтобы отдельный исчезнувший файл не ломал обход. */
async function safeStat(abs: string): Promise<fs.Stats | undefined> {
    try {
        return await fs.promises.stat(abs);
    } catch {
        return undefined;
    }
}
