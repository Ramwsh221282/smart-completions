import { FileMode } from './mode-types';
import { RecentEdit } from './edit-history-types';
import { DiagnosticDTO } from './editor-dto';
import { FimModelId, GenerationMode } from './model-types';

/** Какие источники контекста включены (только по доступным слотам модели). */
export interface FimContextSources {
    /** История недавних правок. */
    recentEdits: boolean;
    /** Repo-контекст (RAG-соседи через repo-уровневые слоты модели). */
    repoContext: boolean;
    /** Диагностики (если у модели есть подходящий слот). */
    diagnostics: boolean;
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
    recentEdits?: RecentEdit[];
    diagnostics?: DiagnosticDTO[];
}

/** Ответ FIM (backend → frontend). text уже пост-обработан. */
export interface FimResponse {
    text: string;
    modelId: string;
    fromCache?: boolean;
}
