import * as fs from 'fs';
import * as path from 'path';

const META_VERSION = 1;

export interface FileMeta {
    mtimeMs: number;
    size: number;
}

/** Метаданные индекса для reconcile (mtime/size по файлам). */
export interface IndexMeta {
    version: number;
    embedModel: string;
    dim: number;
    files: Record<string, FileMeta>; // relPath → meta
}

/** Персистентность метаданных индекса (JSON в storage-директории воркспейса). */
export class IndexPersistence {
    constructor(private readonly metaFile: string) {}

    static create(embedModel: string, dim = 0): IndexMeta {
        return { version: META_VERSION, embedModel, dim, files: {} };
    }

    async load(): Promise<IndexMeta | undefined> {
        try {
            const raw = await fs.promises.readFile(this.metaFile, 'utf8');
            const meta = JSON.parse(raw) as IndexMeta;
            return meta.version === META_VERSION ? meta : undefined;
        } catch {
            return undefined;
        }
    }

    async save(meta: IndexMeta): Promise<void> {
        await fs.promises.mkdir(path.dirname(this.metaFile), { recursive: true });
        await fs.promises.writeFile(this.metaFile, JSON.stringify(meta), 'utf8');
    }
}
