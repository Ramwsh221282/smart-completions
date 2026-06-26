// Запись истории недавних правок (recent edits).
// Источник: захват изменений модели Monaco на frontend (edit-history-recorder).
// Для FIM — опциональный источник контекста; для NES — ОБЯЗАТЕЛЬНЫЙ (ядро NES).
export interface RecentEdit {
    /** URI документа, к которому относится правка. */
    uri: string;
    /** Унифицированный diff (git-style hunk) этой правки. */
    unifiedDiff: string;
    /** Время правки (Unix ms). */
    timestamp: number;
}
