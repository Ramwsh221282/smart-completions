import { Chunk } from './chunk-meta';

const MIN_CHARS = 16;

/**
 * Чанкование не-кода (markdown/plaintext/latex/typst и т.п.): по абзацам
 * (разделение пустой строкой); крупные абзацы режутся окнами строк.
 */
export function chunkProse(
    filePath: string,
    source: string,
    languageId: string,
    windowLines = 40,
): Chunk[] {
    const lines = source.split('\n');
    const chunks: Chunk[] = [];
    let para: string[] = [];
    let paraStart = 0; // 0-based индекс строки начала абзаца

    const flush = (endLine: number): void => {
        const text = para.join('\n').trim();
        if (text.length >= MIN_CHARS) {
            if (para.length > windowLines) {
                for (let i = 0; i < para.length; i += windowLines) {
                    const slice = para.slice(i, i + windowLines).join('\n').trim();
                    if (slice.length >= MIN_CHARS) {
                        chunks.push({
                            filePath,
                            startLine: paraStart + i + 1,
                            endLine: paraStart + Math.min(i + windowLines, para.length),
                            language: languageId,
                            nodeType: 'paragraph',
                            text: slice,
                        });
                    }
                }
            } else {
                chunks.push({
                    filePath,
                    startLine: paraStart + 1,
                    endLine,
                    language: languageId,
                    nodeType: 'paragraph',
                    text,
                });
            }
        }
        para = [];
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '') {
            if (para.length > 0) {
                flush(i); // последняя содержательная строка — 1-based индекс = i
            }
            paraStart = i + 1;
        } else {
            if (para.length === 0) {
                paraStart = i;
            }
            para.push(line);
        }
    }
    if (para.length > 0) {
        flush(lines.length);
    }
    return chunks;
}
