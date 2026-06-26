import { DiagnosticDTO, PositionDTO, RangeDTO, TextEditDTO } from '../editor-dto';
import { RecentEdit } from '../edit-history-types';
import { FileMode } from '../mode-types';
import { NesModelId } from '../model-types';
import type { NesResponseMeta } from '../nes-types';
import type { SweepModelProfile } from './profiles';

// Подмножество NesModelId ограниченное Sweep-моделями; нужен для типобезопасного разветвления между sweep-default и sweep-small.
export type SweepModelId = Extract<NesModelId, 'sweep-default' | 'sweep-small'>;

// Контролирует размер генерации; влияет на maxTokens и задаётся пользователем в настройках на модель.
export type SweepEditVolume = 'small' | 'medium' | 'large';

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
    requestId: string;
    meta: NesResponseMeta;
}
