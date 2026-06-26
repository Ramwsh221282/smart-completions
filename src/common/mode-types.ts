// Режим обработки файла: код (tree-sitter) или проза (fallback по абзацам/строкам).
// Определяется по наличию tree-sitter грамматики для languageId.
export type FileMode = 'code' | 'prose';
