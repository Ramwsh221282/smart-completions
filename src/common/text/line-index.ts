/** Вычисляет индекс строки по offset без split, чтобы горячие reject/trimming пути не аллоцировали массивы. */
export function lineIndexAtOffset(text: string, offset: number): number {
    const safeOffset = Math.max(0, Math.min(offset, text.length));
    let line = 0;
    for (let i = 0; i < safeOffset; i++) {
        if (text.charCodeAt(i) === 10) {
            line++;
        }
    }
    return line;
}

/** Считает LF-строки без разбиения текста, чтобы дешёвые gate-проверки не создавали мусор. */
export function countLines(text: string): number {
    let count = 1;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) {
            count++;
        }
    }
    return count;
}
