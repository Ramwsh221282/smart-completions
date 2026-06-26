/** Запись чанка в векторном хранилище. */
export interface ChunkRecord {
    id: string;
    filePath: string;
    startLine: number;
    endLine: number;
    language: string;
    nodeType: string;
    text: string;
    vector: number[];
}

/** Результат поиска (вектор/лексика). */
export interface VectorHit {
    record: ChunkRecord;
    /** Оценка релевантности (для слияния RRF используется ранг, не абсолютное значение). */
    score: number;
}

/**
 * Абстракция над векторным хранилищем (LanceDB embedded | ChromaDB сервер).
 * Реализации: lancedb-store.ts, chromadb-store.ts.
 */
export interface VectorStore {
    /** Инициализация (подключение/создание коллекции). */
    init(): Promise<void>;
    /** Идемпотентный upsert (по id). */
    upsert(records: ChunkRecord[]): Promise<void>;
    /** Удалить все чанки файла (перед переиндексацией файла). */
    removeByFile(filePath: string): Promise<void>;
    /** Векторный (cosine) поиск top-k. */
    vectorSearch(queryVector: number[], k: number): Promise<VectorHit[]>;
    /** Все записи (для восстановления in-memory BM25 при reconcile). vector можно не возвращать. */
    getAll(): Promise<ChunkRecord[]>;
    /** Число чанков. */
    count(): Promise<number>;
    /** Очистить хранилище. */
    clear(): Promise<void>;
    /** Освободить ресурсы. */
    dispose(): Promise<void>;
}
