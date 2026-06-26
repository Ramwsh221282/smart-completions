import { FileMode } from './mode-types';
import { RecentEdit } from './edit-history-types';
import { DiagnosticDTO, RangeDTO, PositionDTO, TextEditDTO } from './editor-dto';
import { NesModelId } from './model-types';
import type { SweepModelProfile } from './sweep/profiles';

/** Объём предлагаемой правки/диффа (не «длина генерации»). */
export type NesEditVolume = 'small' | 'medium' | 'large';

/** Настройки активной NES-модели (push'ом через configure()). */
export interface NesConfig {
    modelId: NesModelId;
    llamaUrl: string;
    contextSize: number;
    debounceMs: number;
    /** Объём предлагаемой правки/диффа. */
    editVolume: NesEditVolume;
    /** Тумблер RAG на эту модель. */
    ragEnabled: boolean;
    /** inject inline diagnostics — ТОЛЬКО для sweep-small (1.5B/0.5B). */
    injectInlineDiagnostics?: boolean;
    /** Сколько связанных файлов (search/LSP/SCM) класть в Зону A. */
    relatedTopN: number;
    /** Бюджет символов для построения retrieval/LSP-запросов из edit-сигнала. */
    queryMaxChars: number;
    /** Sweep profile resolved from model + small-size preferences. */
    profile: SweepModelProfile;
    /** Exact llama.cpp model field; free string to match the running server. */
    requestModelName: string;
}

/**
 * Запрос NES (frontend → backend).
 * recentEdits ОБЯЗАТЕЛЕН; если пуст — backend не запускает модель.
 */
export interface NesRelatedFile {
    filePath: string;
    content: string;
}

export interface NesOutputSnippet {
    channel: string;
    text: string;
}

export interface NesRequest {
    requestId: string;
    uri: string;
    languageId: string;
    fileMode: FileMode;
    /** Окно вокруг курсора (±N строк), а не весь файл. */
    windowText: string;
    /** Начало windowText в координатах документа. */
    windowStart: PositionDTO;
    /** Широкий контекст текущего файла для первого Sweep file-блока. */
    broadFileText?: string;
    broadFileStartLine?: number;
    /** Окно у курсора ДО последней правки (Зона D, original/). */
    originalWindowText?: string;
    /** Смещение курсора внутри windowText (UTF-16). */
    cursorOffset: number;
    recentEdits: RecentEdit[];
    diagnostics?: DiagnosticDTO[];
    /** Связанные файлы из LSP/search (нативные file-блоки в зоне контекста). */
    relatedFiles?: NesRelatedFile[];
    /** Компактная outline-карта текущего файла. */
    outline?: string;
    /** Сниппеты Output-каналов (build/test логи). */
    outputSnippets?: NesOutputSnippet[];
}

/** Статус backend-ответа нужен telemetry, чтобы отделять edit/no-edit/reject/error без парсинга логов. */
export type NesResponseStatus = 'edit' | 'no-edit' | 'rejected' | 'overflow' | 'error';

/** Метаданные NES-ответа связывают backend outcome с показом, accept и dismiss на frontend. */
export interface NesResponseMeta {
    status: NesResponseStatus;
    rejectReason?: string;
    durationMs: number;
    promptTokens?: number;
    tokenMode: 'tokenizer' | 'char-fallback';
    contextProfile: string;
    editLineCount?: number;
}

/** Ответ NES (backend → frontend) с правками, которые frontend показывает во View Zone. */
export interface NesResponse {
    edits: TextEditDTO[];
    /** Где применяется правка (для View Zone и подсветки). */
    primaryRange?: RangeDTO;
    /** Цель прыжка курсора, если правка вне строки курсора. */
    jumpTo?: PositionDTO;
    modelId: string;
    requestId: string;
    meta: NesResponseMeta;
}
