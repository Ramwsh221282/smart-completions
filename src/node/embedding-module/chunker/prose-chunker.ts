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

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '') {
            if (para.length > 0) {
                pushParagraphChunks(chunks, filePath, languageId, para, paraStart, i, windowLines);
                para = [];
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
        pushParagraphChunks(chunks, filePath, languageId, para, paraStart, lines.length, windowLines);
    }
    return chunks;
}

function pushParagraphChunks(
    chunks: Chunk[],
    filePath: string,
    languageId: string,
    paragraphLines: string[],
    paragraphStart: number,
    endLine: number,
    windowLines: number,
): void {
    const text = paragraphLines.join('\n').trim();
    if (text.length < MIN_CHARS) {
        return;
    }
    if (paragraphLines.length > windowLines) {
        pushWindowedParagraphChunks(chunks, filePath, languageId, paragraphLines, paragraphStart, windowLines);
        return;
    }
    chunks.push({
        filePath,
        startLine: paragraphStart + 1,
        endLine,
        language: languageId,
        nodeType: 'paragraph',
        text,
    });
}

function pushWindowedParagraphChunks(
    chunks: Chunk[],
    filePath: string,
    languageId: string,
    paragraphLines: string[],
    paragraphStart: number,
    windowLines: number,
): void {
    for (let i = 0; i < paragraphLines.length; i += windowLines) {
        const slice = paragraphLines.slice(i, i + windowLines).join('\n').trim();
        if (slice.length < MIN_CHARS) {
            continue;
        }
        chunks.push({
            filePath,
            startLine: paragraphStart + i + 1,
            endLine: paragraphStart + Math.min(i + windowLines, paragraphLines.length),
            language: languageId,
            nodeType: 'paragraph',
            text: slice,
        });
    }
}
