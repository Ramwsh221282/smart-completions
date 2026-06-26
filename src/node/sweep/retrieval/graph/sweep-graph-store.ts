import Database from 'better-sqlite3';

/** SQL-схема CodeGraph: декларации символов и ссылки на имена с индексами под точечные lookup-запросы. */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  file TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
CREATE INDEX IF NOT EXISTS idx_symbols_file_range ON symbols(file, start_line, end_line);
CREATE TABLE IF NOT EXISTS refs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);
CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file);
`;

export interface SymbolRow {
    name: string;
    kind: string;
    file: string;
    startLine: number;
    endLine: number;
    body: string;
}

export interface RefRow {
    name: string;
    file: string;
    line: number;
}

export interface SymbolCatalogRow extends SymbolRow {}

/** Абстракция CodeGraph storage изолирует каналы от конкретного SQLite engine. */
export interface SweepGraphStore {
    reset(): void;
    insertSymbols(rows: SymbolRow[]): void;
    insertRefs(rows: RefRow[]): void;
    deleteFile(file: string): void;
    declarationsByName(name: string, limit: number): SymbolRow[];
    referencesToName(name: string, limit: number): RefRow[];
    namesReferencedByFile(file: string, limit: number): string[];
    symbolsContainingLine(file: string, line: number, limit: number): SymbolRow[];
    allSymbolNames(): SymbolCatalogRow[];
    dispose(): void;
}

/** better-sqlite3-backed graph store использует WAL, prepared statements и batch transactions. */
export class BetterSqlite3GraphStore implements SweepGraphStore {
    private readonly db: Database.Database;
    private readonly insertSymbolStmt: Database.Statement;
    private readonly insertRefStmt: Database.Statement;
    private readonly insertSymbolsTx: (rows: SymbolRow[]) => void;
    private readonly insertRefsTx: (rows: RefRow[]) => void;

    /** Открывает disk-backed БД графа и подготавливает statements один раз для горячих lookup-путей. */
    constructor(dbFilePath: string) {
        this.db = new Database(dbFilePath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.exec(SCHEMA_SQL);
        this.insertSymbolStmt = this.db.prepare('INSERT INTO symbols(name, kind, file, start_line, end_line, body) VALUES (?, ?, ?, ?, ?, ?)');
        this.insertRefStmt = this.db.prepare('INSERT INTO refs(name, file, line) VALUES (?, ?, ?)');
        this.insertSymbolsTx = this.db.transaction((rows: SymbolRow[]) => this.runInsertSymbols(rows));
        this.insertRefsTx = this.db.transaction((rows: RefRow[]) => this.runInsertRefs(rows));
    }

    /** Пересоздаёт пустую схему при полном rebuild воркспейса. */
    reset(): void {
        this.db.exec('DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS refs;');
        this.db.exec(SCHEMA_SQL);
    }

    /** Вставляет декларации одной транзакцией, чтобы полный индекс не платил fsync на каждую строку. */
    insertSymbols(rows: SymbolRow[]): void {
        if (rows.length === 0) {
            return;
        }
        this.insertSymbolsTx(rows);
    }

    /** Вставляет ссылки одной транзакцией, чтобы live reindex оставался дешёвым. */
    insertRefs(rows: RefRow[]): void {
        if (rows.length === 0) {
            return;
        }
        this.insertRefsTx(rows);
    }

    /** Удаляет все записи файла перед инкрементальной переиндексацией или удалением. */
    deleteFile(file: string): void {
        this.db.prepare('DELETE FROM symbols WHERE file = ?').run(file);
        this.db.prepare('DELETE FROM refs WHERE file = ?').run(file);
    }

    /** Возвращает декларации точного имени из индексированного графа. */
    declarationsByName(name: string, limit: number): SymbolRow[] {
        return this.db.prepare('SELECT name, kind, file, start_line AS startLine, end_line AS endLine, body FROM symbols WHERE name = ? LIMIT ?').all(name, limit) as SymbolRow[];
    }

    /** Возвращает места использования имени для поиска caller-контекста. */
    referencesToName(name: string, limit: number): RefRow[] {
        return this.db.prepare('SELECT name, file, line FROM refs WHERE name = ? LIMIT ?').all(name, limit) as RefRow[];
    }

    /** Возвращает уникальные имена, на которые ссылается файл, для будущего расширения graph traversal. */
    namesReferencedByFile(file: string, limit: number): string[] {
        const rows = this.db.prepare('SELECT DISTINCT name FROM refs WHERE file = ? LIMIT ?').all(file, limit) as Array<{ name: string }>;
        const out = new Array<string>(rows.length);
        for (let i = 0; i < rows.length; i++) {
            out[i] = rows[i].name;
        }
        return out;
    }

    /** Находит ближайшую декларацию-область, содержащую строку ссылки, чтобы вернуть полезный context body. */
    symbolsContainingLine(file: string, line: number, limit: number): SymbolRow[] {
        return this.db.prepare(
            'SELECT name, kind, file, start_line AS startLine, end_line AS endLine, body FROM symbols WHERE file = ? AND start_line <= ? AND end_line >= ? ORDER BY (end_line - start_line) ASC LIMIT ?',
        ).all(file, line, line, limit) as SymbolRow[];
    }

    /** Возвращает каталог символов для полного rebuild fuzzy канала. */
    allSymbolNames(): SymbolCatalogRow[] {
        return this.db.prepare('SELECT name, kind, file, start_line AS startLine, end_line AS endLine, body FROM symbols ORDER BY file, start_line').all() as SymbolCatalogRow[];
    }

    /** Закрывает SQLite handle, чтобы Electron backend мог корректно завершиться. */
    dispose(): void {
        this.db.close();
    }

    /** Внутренний batch runner деклараций удерживает форму цикла мономорфной для prepared statement. */
    private runInsertSymbols(rows: SymbolRow[]): void {
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            this.insertSymbolStmt.run(row.name, row.kind, row.file, row.startLine, row.endLine, row.body);
        }
    }

    /** Внутренний batch runner ссылок удерживает форму цикла мономорфной для prepared statement. */
    private runInsertRefs(rows: RefRow[]): void {
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            this.insertRefStmt.run(row.name, row.file, row.line);
        }
    }
}
