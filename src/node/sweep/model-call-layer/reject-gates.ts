import type { PositionDTO, TextEditDTO } from '../../../common/editor-dto';
import { normalizeCrlf } from '../../../common/text/crlf';
import { countLines, lineIndexAtOffset } from '../../../common/text/line-index';

// Компилируется один раз вне функции; используется в whitespace-гейте и не должна пересоздаваться на каждый вызов.
const WHITESPACE = /\s+/g;

/**
 * Входные данные для набора reject-гейтов; один объект вместо отдельных аргументов
 * чтобы добавление нового гейта не меняло сигнатуру sweepRejectReason.
 */
export interface SweepRejectGateInput {
    oldWindowText: string;
    updatedWindowText: string;
    windowStart: PositionDTO;
    cursorOffset?: number;
    edit: TextEditDTO;
}

/**
 * Последовательно прогоняет reject-гейты от дешёвых к дорогим; первый сработавший
 * возвращает причину отказа чтобы плохой edit не доходил до View Zone и не отвлекал пользователя.
 */
export function sweepRejectReason(input: SweepRejectGateInput): string | undefined {
    const oldText = normalizeCrlf(input.oldWindowText);
    const newText = normalizeCrlf(input.updatedWindowText);
    if (sameWithoutWhitespace(oldText, newText)) {
        return 'whitespace-only';
    }
    const oldLineCount = countLines(oldText);
    const newLineCount = countLines(newText);
    if (windowShapeRejected(oldLineCount, newLineCount)) {
        return 'window-shape';
    }
    if (pureInsertionAboveCursor(input.edit, input.windowStart, oldText, input.cursorOffset)) {
        return 'pure-insertion-above-cursor';
    }
    if (editVolumeRejected(input.edit, oldLineCount)) {
        return 'edit-volume';
    }
    return undefined;
}

// Отбраковывает правки, меняющие только пробелы; форматные изменения без семантики не стоит показывать пользователю.
function sameWithoutWhitespace(oldText: string, newText: string): boolean {
    return oldText !== newText && oldText.replace(WHITESPACE, '') === newText.replace(WHITESPACE, '');
}

/**
 * Отбраковывает ответы, резко меняющие число строк окна; сильный рост или сжатие —
 * признак галлюцинации или context drift, а не точечной правки.
 */
function windowShapeRejected(oldLineCount: number, newLineCount: number): boolean {
    const maxGrowth = Math.max(8, oldLineCount);
    const minLines = Math.max(1, Math.floor(oldLineCount * 0.25));
    return newLineCount > oldLineCount + maxGrowth || newLineCount < minLines;
}

/**
 * Отбраковывает вставки строк строго выше курсора без изменения строки курсора;
 * штатный фильтр is_pure_insertion_above_cursor из inference.py Sweep — такие правки низкоценны.
 */
function pureInsertionAboveCursor(edit: TextEditDTO, windowStart: PositionDTO, oldText: string, cursorOffset: number | undefined): boolean {
    if (cursorOffset === undefined || edit.range.start.line !== edit.range.end.line || edit.range.start.character !== edit.range.end.character) {
        return false;
    }
    if (!edit.newText || countLines(edit.newText) <= 1) {
        return false;
    }
    const cursorLine = windowStart.line + lineIndexAtOffset(oldText, cursorOffset);
    return edit.range.start.line < cursorLine && edit.range.end.line <= cursorLine;
}

/**
 * Отбраковывает правки, затрагивающие слишком много строк относительно окна;
 * по блогу Sweep чрезмерные вставки/удаления снижают acceptance и скорее всего означают drift.
 */
function editVolumeRejected(edit: TextEditDTO, oldLineCount: number): boolean {
    const removedLines = Math.max(0, edit.range.end.line - edit.range.start.line);
    const insertedLines = countLines(edit.newText);
    const touchedLines = Math.max(removedLines, insertedLines);
    const limit = Math.max(12, Math.ceil(oldLineCount * 0.75));
    return touchedLines > limit;
}
