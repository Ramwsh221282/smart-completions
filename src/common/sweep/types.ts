import { DiagnosticDTO, PositionDTO, RangeDTO, TextEditDTO } from '../editor-dto';
import { RecentEdit } from '../edit-history-types';
import { FileMode } from '../mode-types';
import { NesModelId } from '../model-types';
import type { SweepModelProfile } from './profiles';

// Подмножество NesModelId ограниченное Sweep-моделями; нужен для типобезопасного разветвления между sweep-default и sweep-small.
export type SweepModelId = Extract<NesModelId, 'sweep-default' | 'sweep-small'>;

// Контролирует размер генерации; влияет на maxTokens и задаётся пользователем в настройках на модель.
export type SweepEditVolume = 'small' | 'medium' | 'large';

/** Default Qwen3-Reranker instruction for next-edit retrieval ranking. */
export const DEFAULT_SWEEP_RERANK_INSTRUCTION = "Instruct: Given the current code edit and cursor context, judge whether the code snippet is useful for predicting the developer's next edit. Prefer snippets that define or call the symbols being edited.";

/** Default Sweep rerank config keeps the second-stage ranking opt-in and latency-bounded. */
export const DEFAULT_SWEEP_RERANK_CONFIG: SweepRerankConfig = {
    enabled: false,
    llamaUrl: 'http://127.0.0.1:8040/v1',
    model: 'qwen3-reranker-0.6b',
    instruction: DEFAULT_SWEEP_RERANK_INSTRUCTION,
    candidatePoolN: 24,
    rerankTopN: 16,
    finalTopN: 8,
    ambiguityMargin: 0.002,
    timeoutMs: 1500,
    maxDocChars: 2000,
};

export interface SweepRerankConfig {
    enabled: boolean;
    llamaUrl: string;
    model: string;
    instruction: string;
    candidatePoolN: number;
    rerankTopN: number;
    finalTopN: number;
    ambiguityMargin: number;
    timeoutMs: number;
    maxDocChars: number;
}

/**
 * Конфигурация активной Sweep-модели; хранится в бекенде и обновляется через NES-фасад при изменении preferences.
 * Параметры model-specific потому что слоты контекста, inject-diagnostics и RAG различаются между sweep-default и sweep-small.
 */
export interface SweepConfig {
    modelId: SweepModelId;
    llamaUrl: string;
    contextSize: number;
    debounceMs: number;
    editVolume: SweepEditVolume;
    ragEnabled: boolean;
    injectInlineDiagnostics?: boolean;
    relatedTopN: number;
    queryMaxChars: number;
    profile: SweepModelProfile;
    requestModelName: string;
    rerank: SweepRerankConfig;
}

/**
 * Фрагмент связанного файла для вставки в нативный `<|file_sep|>{path}` блок Sweep-промпта;
 * путь должен быть workspace-relative чтобы совпадать с training-форматом.
 */
export interface SweepRelatedFile {
    filePath: string;
    content: string;
}

/**
 * Отфильтрованный фрагмент Output-канала для вставки в `output/{channel}` псевдофайл Sweep-промпта;
 * channel используется как имя псевдофайла чтобы модель понимала источник вывода.
 */
export interface SweepOutputSnippet {
    channel: string;
    text: string;
}

/**
 * Полный запрос фронтенда к бекенду для построения Sweep training-format промпта;
 * содержит всё что нужно бекенду: окно, курсор, история правок, контекст и метаданные файла.
 */
export interface SweepRequest {
    requestId: string;
    uri: string;
    languageId: string;
    fileMode: FileMode;
    windowText: string;
    windowStart: PositionDTO;
    broadFileText: string;
    broadFileStartLine: number;
    originalWindowText?: string;
    cursorOffset: number;
    recentEdits: RecentEdit[];
    diagnostics?: DiagnosticDTO[];
    relatedFiles?: SweepRelatedFile[];
    outline?: string;
    outputSnippets?: SweepOutputSnippet[];
}

/**
 * Ответ Sweep-бекенда; не зависит от конкретной модели чтобы NesViewZoneRenderer
 * мог отображать правки без знания о том какая именно Sweep-модель их сгенерировала.
 */
export interface SweepResponse {
    edits: TextEditDTO[];
    primaryRange?: RangeDTO;
    jumpTo?: PositionDTO;
    modelId: SweepModelId;
}
