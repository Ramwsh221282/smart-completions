/**
 * Нормализация переносов строк CRLF/CR → LF.
 * LF-only текст упрощает сборку prompt'ов, стоп-токены и вычисление смещений.
 */
export function normalizeCrlf(text: string): string {
    return text.replace(/\r\n?/g, '\n');
}

// Разделитель строк для любых переносов; компилируется один раз. split не использует lastIndex — переиспользование безопасно.
const LINE_SPLIT = /\r\n|\r|\n/;

/**
 * Разбивает текст на строки за один проход без промежуточной нормализованной строки.
 * Эквивалентно normalizeCrlf(text).split('\n'), но экономит одну аллокацию строки размером со весь текст.
 */
export function splitLines(text: string): string[] {
    return text.split(LINE_SPLIT);
}
