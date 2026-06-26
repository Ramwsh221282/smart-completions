import { connect, Connection, Table } from '@lancedb/lancedb';
import { ChunkRecord, VectorHit, VectorStore } from './iface';

const TABLE = 'smart_completions_chunks';

/** Нормализация к единичной длине (cosine-ранжирование). */
function normalize(v: number[]): number[] {
    let s = 0;
    for (let i = 0; i < v.length; i++) {
        const x = v[i];
        s += x * x;
    }
    const n = Math.sqrt(s) || 1;
    const out = new Array<number>(v.length);
    for (let i = 0; i < v.length; i++) {
        out[i] = v[i] / n;
    }
    return out;
}

/** Экранирование одинарных кавычек для SQL-предиката LanceDB. */
function esc(s: string): string {
    return s.replace(/'/g, "''");
}

interface Row {
    id: string;
    vector: number[];
    text: string;
    file_path: string;
    start_line: number;
    end_line: number;
    language: string;
    node_type: string;
}

/**
 * LanceDB-хранилище (embedded, native napi). Файлы в каталоге `dir`.
 * Идемпотентность: removeByFile (индексатор) + delete-by-id внутри upsert.
 * Лексическая половина гибрида — отдельный Bm25Index (FTS LanceDB не используем).
 */
export class LanceVectorStore implements VectorStore {
    private conn: Connection | undefined;
    private table: Table | undefined;

    constructor(private readonly dir: string) {}

    async init(): Promise<void> {
        this.conn = await connect(this.dir);
        const names = await this.conn.tableNames();
        if (names.includes(TABLE)) {
            this.table = await this.conn.openTable(TABLE);
        }
    }

    private toRow(r: ChunkRecord): Row {
        return {
            id: r.id,
            vector: normalize(r.vector),
            text: r.text,
            file_path: r.filePath,
            start_line: r.startLine,
            end_line: r.endLine,
            language: r.language,
            node_type: r.nodeType,
        };
    }

    private rowToRecord(row: Record<string, unknown>): ChunkRecord {
        return {
            id: String(row.id),
            filePath: String(row.file_path),
            startLine: Number(row.start_line),
            endLine: Number(row.end_line),
            language: String(row.language),
            nodeType: String(row.node_type),
            text: typeof row.text === 'string' ? row.text : '',
            vector: [],
        };
    }

    async upsert(records: ChunkRecord[]): Promise<void> {
        if (records.length === 0) {
            return;
        }
        const rows = records.map(r => this.toRow(r)) as unknown as Record<string, unknown>[];
        if (!this.table) {
            if (!this.conn) {
                throw new Error('LanceVectorStore not initialized');
            }
            this.table = await this.conn.createTable(TABLE, rows);
            return;
        }
        const ids = records.map(r => `'${esc(r.id)}'`).join(',');
        await this.table.delete(`id IN (${ids})`);
        await this.table.add(rows);
    }

    async removeByFile(filePath: string): Promise<void> {
        if (this.table) {
            await this.table.delete(`file_path = '${esc(filePath)}'`);
        }
    }

    async vectorSearch(queryVector: number[], k: number): Promise<VectorHit[]> {
        if (!this.table) {
            return [];
        }
        const rows = await this.table
            .vectorSearch(normalize(queryVector))
            .distanceType('cosine')
            .limit(k)
            .toArray();
        return rows.map(row => ({
            record: this.rowToRecord(row),
            score: 1 - (typeof row._distance === 'number' ? row._distance : 1),
        }));
    }

    async getAll(): Promise<ChunkRecord[]> {
        if (!this.table) {
            return [];
        }
        const rows = await this.table.query().limit(1_000_000).toArray();
        return rows.map(row => this.rowToRecord(row));
    }

    async count(): Promise<number> {
        return this.table ? this.table.countRows() : 0;
    }

    async clear(): Promise<void> {
        if (this.conn && this.table) {
            await this.conn.dropTable(TABLE);
            this.table = undefined;
        }
    }

    async dispose(): Promise<void> {
        this.table = undefined;
        this.conn = undefined;
    }
}
