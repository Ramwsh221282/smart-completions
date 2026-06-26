import type { EmbeddingConfig } from './embedding-types';
import { DiagnosticDTO } from './editor-dto';
import { RecentEdit } from './edit-history-types';
import type { SweepFuzzyConfig, SweepGraphConfig, SweepRerankConfig } from './sweep/types';
import { FimModelId, GenerationMode } from './model-types';
import { FileMode } from './mode-types';

/** Какие источники контекста включены (только по доступным слотам модели). */
export interface FimContextSources {
    /** История недавних правок. */
    recentEdits: boolean;
    /** Repo-контекст (RAG-соседи через repo-уровневые слоты модели). */
    repoContext: boolean;
    /** Диагностики (если у модели есть подходящий слот). */
    diagnostics: boolean;
}

/** Явно собранный related-файл для repo-level FIM prompt, например LSP definition рядом с курсором. */
export interface FimRelatedFile {
    filePath: string;
    content: string;
    score?: number;
}

/** Конфиг retrieval-пайплайна FIM: graph/fuzzy/rerank живут рядом с FIM, хотя используют shared реализации. */
export interface FimRetrievalConfig {
    rerank: SweepRerankConfig;
    graph: SweepGraphConfig;
    fuzzy: SweepFuzzyConfig;
}

/** Настройки активной FIM-модели (push'ом через configure()). */
export interface FimConfig {
    modelId: FimModelId;
    /** Полный URL llama.cpp (напр. http://127.0.0.1:8000). */
    llamaUrl: string;
    /** Размер контекста (деф = максимум модели; расширять запрещено). */
    contextSize: number;
    /** Пауза перед запросом подсказки, мс. */
    debounceMs: number;
    /** Дискретный объём генерации. */
    generationMode: GenerationMode;
    /** Температура 0.0–0.1. */
    temperature: number;
    /** Тумблер RAG на эту модель. */
    ragEnabled: boolean;
    /** Активный профиль FIM-эмбеддера; меняет только отдельное FIM-пространство индекса. */
    fimEmbedderId: string;
    /** Конфиг отдельного FIM embedding-space; значения читаются из embedding preferences. */
    embedding: EmbeddingConfig;
    /** Конфиг retrieval orchestration для FIM. */
    retrieval: FimRetrievalConfig;
    /** Включённые источники контекста. */
    contextSources: FimContextSources;
}

/** Запрос FIM (frontend → backend). prefix/suffix — ограниченные окна. */
export interface FimRequest {
    requestId: string;
    uri: string;
    languageId: string;
    fileMode: FileMode;
    prefix: string;
    suffix: string;
    generationMode: GenerationMode;
    relatedFiles?: FimRelatedFile[];
    recentEdits?: RecentEdit[];
    diagnostics?: DiagnosticDTO[];
}

/** Ответ FIM (backend → frontend). text уже пост-обработан. */
export interface FimResponse {
    text: string;
    modelId: string;
    fromCache?: boolean;
}
