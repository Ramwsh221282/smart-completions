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
    /** Готовит физическое хранилище к запросам и индексации. */
    init(): Promise<void>;
    /** Принимает уже вычисленные чанки и заменяет записи с теми же id без внешней дедупликации. */
    upsert(records: ChunkRecord[]): Promise<void>;
    /** Удаляет все чанки файла перед его переиндексацией или при удалении файла из индекса. */
    removeByFile(filePath: string): Promise<void>;
    /** Возвращает top-k соседей в том же score-space, который дальше сливается с BM25/RRF. */
    vectorSearch(queryVector: number[], k: number): Promise<VectorHit[]>;
    /** Отдаёт все записи для восстановления in-memory BM25 после reconcile/reopen; vector можно опустить. */
    getAll(): Promise<ChunkRecord[]>;
    /** Нужен главным образом для диагностики и тестов готовности индекса. */
    count(): Promise<number>;
    /** Полностью сбрасывает физическое содержимое индекса без смены backend-конфигурации. */
    clear(): Promise<void>;
    /** Освобождает process-local ресурсы/handles; persisted data может остаться на диске. */
    dispose(): Promise<void>;
}
