import { EmbedModelId, VectorDbId } from './model-types';

/** Настройки секции Embedding / векторных БД (push'ом через configure()). */
export interface EmbeddingConfig {
    embedModel: EmbedModelId;
    /** Полный URL llama.cpp для эмбеддингов. */
    llamaUrl: string;
    vectorDb: VectorDbId;
    /** URL Chroma-сервера (когда vectorDb = chromadb). */
    chromaUrl?: string;
    /** Индексирование репозитория при сохранении. */
    indexOnSave: boolean;
    /** Индексирование при открытии редактора. */
    indexOnOpen: boolean;
    /** Retrieval-параметры. */
    chunkSize: number;
    topN: number;
    /** Окно «хвоста префикса» — сколько последних символов у курсора брать как запрос. */
    prefixTailChars: number;
}

export type IndexState = 'idle' | 'indexing' | 'ready' | 'error';

export interface IndexStatus {
    state: IndexState;
    filesIndexed: number;
    totalFiles: number;
    lastLatencyMs?: number;
    error?: string;
}

export interface IndexProgress {
    processed: number;
    total: number;
    currentFile?: string;
}

export type ConnTargetKind = 'fim' | 'nes' | 'embedding' | 'vector-db';

export interface ConnTarget {
    kind: ConnTargetKind;
    url: string;
}

export interface TestResult {
    ok: boolean;
    detail?: string;
    latencyMs?: number;
}

/** Результат retrieval — сосед-чанк с метаданными. */
export interface Neighbor {
    filePath: string;
    startLine: number;
    endLine: number;
    text: string;
    score: number;
}
