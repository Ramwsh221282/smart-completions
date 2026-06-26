// Запись истории недавних правок (recent edits).
// Источник: захват изменений модели Monaco на frontend (edit-history-recorder).
// Для FIM — опциональный источник контекста; для NES — ОБЯЗАТЕЛЬНЫЙ (ядро NES).
export interface RecentEdit {
    /** URI документа, к которому относится правка. */
    uri: string;
    /** Полный текст ДО правки; нужен FIM recent-edit сниппетам для jsdiff-представления. */
    before?: string;
    /** Полный текст ПОСЛЕ правки; нужен FIM recent-edit сниппетам для jsdiff-представления. */
    after?: string;
    /** Унифицированный diff (git-style hunk) этой правки. */
    unifiedDiff: string;
    /** Время правки (Unix ms). */
    timestamp: number;
}
