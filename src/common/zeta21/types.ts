import type { DiagnosticDTO, PositionDTO, RangeDTO, TextEditDTO } from '../editor-dto';
import type { RecentEdit } from '../edit-history-types';
import type { FileMode } from '../mode-types';
import type { SweepFuzzyConfig, SweepGraphConfig, SweepRerankConfig } from '../sweep/types';

// Один related-файл для prefix-зоны Zeta; score сохраняется чтобы trimming мог предпочитать более сильные сигналы.
export interface ZetaRelatedFile {
    filePath: string;
    content: string;
    score?: number;
}

// Один редактируемый регион в координатах windowText; markerIndex всегда открывает пару marker_N / marker_N+1.
export interface ZetaEditableRegion {
    markerIndex: number;
    startOffset: number;
    endOffset: number;
}

// Zeta request фиксирует SPM-зоны и контекст окна, чтобы backend не восстанавливал их заново из Monaco-состояния.
export interface ZetaRequest {
    requestId: string;
    uri: string;
    languageId: string;
    fileMode: FileMode;
    prefixText: string;
    windowText: string;
    suffixText: string;
    windowStart: PositionDTO;
    cursorOffset: number;
    regions: ZetaEditableRegion[];
    recentEdits: RecentEdit[];
    relatedFiles: ZetaRelatedFile[];
    diagnostics: DiagnosticDTO[];
}

// Отдельный Zeta-config читается из тех же preferences, но хранит только поля нужные zeta21-пайплайну.
export interface ZetaConfig {
    llamaUrl: string;
    requestModelName: string;
    contextSize: number;
    debounceMs: number;
    ragEnabled: boolean;
    relatedTopN: number;
    queryMaxChars: number;
    rerank: SweepRerankConfig;
    graph: SweepGraphConfig;
    fuzzy: SweepFuzzyConfig;
}

// Zeta response не зависит от renderer-деталей и отдаёт только список правок плюс primary range для навигации.
export interface ZetaResponse {
    edits: TextEditDTO[];
    primaryRange: RangeDTO | null;
    jumpTo: PositionDTO | null;
    modelId: string;
}

// Стоп-токены Zeta 2.1 закрывают generation за пределами переписанных регионов и FIM-секций.
export const ZETA_STOP_TOKENS = ['<|endoftext|>', '<[fim-suffix]>', '<[fim-prefix]>'] as const;

// Спец-токены Zeta 2.1 вынесены в константы чтобы не плодить строковые литералы по всему пайплайну.
export const ZETA_TOKENS = {
    fimSuffix: '<[fim-suffix]>',
    fimPrefix: '<[fim-prefix]>',
    fimMiddle: '<[fim-middle]>',
    filename: '<filename>',
    editHistory: 'edit_history',
    userCursor: '<|user_cursor|>',
} as const;
