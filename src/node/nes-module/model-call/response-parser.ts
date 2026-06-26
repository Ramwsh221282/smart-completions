import { PositionDTO, RangeDTO, TextEditDTO } from '../../../common/editor-dto';
import { normalizeCrlf } from '../../util/crlf';

export interface ParseNesCompletionInput {
    rawText: string;
    oldWindowText: string;
    windowStart: PositionDTO;
    stopTokens: string[];
    /** Префилл из updated/ (Sweep): модель продолжает с него, поэтому окно = prefill + rawText. */
    prefill?: string;
}

export interface ParsedNesCompletion {
    edits: TextEditDTO[];
    primaryRange?: RangeDTO;
    jumpTo?: PositionDTO;
}

export function parseNesCompletion(input: ParseNesCompletionInput): ParsedNesCompletion {
    const cleaned = cleanResponse(input.rawText, input.stopTokens);
    // Sweep продолжает из updated/{prefill}: полное обновлённое окно = prefill + ответ модели.
    const prefill = input.prefill ? normalizeCrlf(input.prefill) : '';
    const updatedWindow = prefill ? prefill + cleaned : cleaned;
    if (!updatedWindow || updatedWindow.trim() === 'NO_EDITS') {
        return { edits: [] };
    }
    const edit = diffWindows(normalizeCrlf(input.oldWindowText), updatedWindow, input.windowStart);
    if (!edit) {
        return { edits: [] };
    }
    return {
        edits: [edit],
        primaryRange: edit.range,
        jumpTo: edit.range.start,
    };
}

function cleanResponse(rawText: string, stopTokens: string[]): string {
    let text = normalizeCrlf(rawText);
    // Zeta 2.1 возвращает переписанный регион между <|marker_1|> и <|marker_2|>.
    // Вырезаем содержимое региона и снимаем по одному переводу строки, добавленному
    // форматированием маркеров, чтобы сравнение с исходным окном было корректным.
    const markerStart = text.lastIndexOf('<|marker_1|>');
    if (markerStart >= 0) {
        text = text.slice(markerStart + '<|marker_1|>'.length).replace(/^\n/, '');
    }
    const markerEnd = text.indexOf('<|marker_2|>');
    if (markerEnd >= 0) {
        text = text.slice(0, markerEnd).replace(/\n$/, '');
    }
    text = text
        .replace(/<\|user_cursor\|>/g, '')
        .replace(/<\|cursor\|>/g, '')
        .replace(/<\|marker_\d+\|>/g, '')
        .replace(/>>>>>>> UPDATED/g, '')
        .trimEnd();
    for (const stop of stopTokens) {
        const index = text.indexOf(stop);
        if (index >= 0) {
            text = text.slice(0, index).trimEnd();
        }
    }
    return text;
}

function diffWindows(oldText: string, newText: string, windowStart: PositionDTO): TextEditDTO | undefined {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
        prefix++;
    }
    let suffix = 0;
    while (
        suffix < oldLines.length - prefix &&
        suffix < newLines.length - prefix &&
        oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
        suffix++;
    }
    if (prefix === oldLines.length && prefix === newLines.length) {
        return undefined;
    }
    const oldEnd = oldLines.length - suffix;
    const newEnd = newLines.length - suffix;
    const replaceLines = newLines.slice(prefix, newEnd);
    const endsBeforeRetainedLine = oldEnd < oldLines.length;
    return {
        range: {
            start: { line: windowStart.line + prefix, character: prefix === 0 ? windowStart.character : 0 },
            end: endPosition(windowStart, oldLines, oldEnd),
        },
        newText: replaceLines.join('\n') + (endsBeforeRetainedLine && replaceLines.length > 0 ? '\n' : ''),
    };
}

function endPosition(windowStart: PositionDTO, oldLines: string[], oldEnd: number): PositionDTO {
    if (oldEnd < oldLines.length) {
        return { line: windowStart.line + oldEnd, character: 0 };
    }
    const last = oldLines.length - 1;
    return { line: windowStart.line + last, character: oldLines[last]?.length ?? 0 };
}
