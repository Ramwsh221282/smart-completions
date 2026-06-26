import { md5 } from '../../util/hash';

/** Семантический чанк с метаданными (file_path · диапазон строк · язык · тип узла). */
export interface Chunk {
    filePath: string;
    startLine: number;
    endLine: number;
    language: string;
    nodeType: string;
    text: string;
}

/**
 * Идемпотентный id чанка = md5(file_path:start_line:end_line).
 * Переиндексация заменяет, а не плодит дубликаты.
 */
export function chunkId(filePath: string, startLine: number, endLine: number): string {
    return md5(`${filePath}:${startLine}:${endLine}`);
}
