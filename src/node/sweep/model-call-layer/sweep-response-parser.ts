import { PositionDTO, RangeDTO, TextEditDTO } from '../../../common/editor-dto';
import { SweepLogger } from '../../../common/sweep/logger';
import { normalizeCrlf } from '../../../common/text/crlf';
import { sweepRejectReason } from './reject-gates';

// Логгер парсера; нужен для диагностики размера очищенного ответа и того какой диапазон был заменён.
const LOG = new SweepLogger('node:model-call:sweep-response-parser');

// Маркеры Sweep удаляются одной регуляркой за один проход; компилируется один раз вне горячего пути парсинга.
const SWEEP_MARKERS = /<\|cursor\|>|<\|file_sep\|>/g;

// Входные данные для парсинга: сырой ответ модели, исходное окно и метаданные необходимые для вычисления диапазона замены.
export interface ParseSweepCompletionInput {
    rawText: string;
    oldWindowText: string;
    windowStart: PositionDTO;
    stopTokens: string[];
    prefill?: string;
    cursorOffset?: number;
}

// Результат парсинга: список правок готовых для NesViewZoneRenderer и позиция для jumpOrAccept навигации.
export interface ParsedSweepCompletion {
    edits: TextEditDTO[];
    primaryRange?: RangeDTO;
    jumpTo?: PositionDTO;
    updatedWindow?: string;
    status: 'edit' | 'no-edit' | 'rejected';
    rejectReason?: string;
}

/**
 * Парсит ответ модели в одну window-replacement правку для NesViewZoneRenderer;
 * prefill + ответ составляют updated/ окно которое сравнивается с original/ для вычисления дельты.
 */
export function parseSweepCompletion(input: ParseSweepCompletionInput): ParsedSweepCompletion {
    const cleaned = cleanSweepResponse(input.rawText, input.stopTokens);
    const prefill = input.prefill ? normalizeCrlf(input.prefill) : '';
    const updatedWindow = prefill ? prefill + cleaned : cleaned;
    LOG.info('Sweep response cleaned', {
        rawChars: input.rawText.length,
        cleanedChars: cleaned.length,
        prefillChars: prefill.length,
        updatedWindowChars: updatedWindow.length,
    });
    if (!updatedWindow || updatedWindow.trim() === 'NO_EDITS') {
        LOG.info('Sweep response parsed as no-op', { reason: updatedWindow ? 'NO_EDITS' : 'empty' });
        return { edits: [], status: 'no-edit', rejectReason: updatedWindow ? 'NO_EDITS' : 'empty' };
    }
    const edit = diffWindows(normalizeCrlf(input.oldWindowText), updatedWindow, input.windowStart);
    if (!edit) {
        LOG.info('Sweep response produced no textual diff');
        return { edits: [], updatedWindow, status: 'no-edit', rejectReason: 'no-diff' };
    }
    const rejectReason = sweepRejectReason({
        oldWindowText: input.oldWindowText,
        updatedWindowText: updatedWindow,
        windowStart: input.windowStart,
        cursorOffset: input.cursorOffset,
        edit,
    });
    if (rejectReason !== undefined) {
        LOG.info('Sweep response rejected by gate', { reason: rejectReason, range: edit.range });
        return { edits: [], updatedWindow, status: 'rejected', rejectReason };
    }
    LOG.info('Sweep response parsed into edit', { range: edit.range, newTextChars: edit.newText.length });
    if (process.env.NODE_ENV === 'development') {
        LOG.debug('Sweep parsed edit text', { newText: edit.newText });
    }
    return {
        edits: [edit],
        primaryRange: edit.range,
        jumpTo: edit.range.start,
        updatedWindow,
        status: 'edit',
    };
}

/**
 * Убирает стоп-токены, маркеры курсора и file_sep из сырого ответа модели;
 * нужен чтобы случайно сгенерированные служебные токены не попали в правку пользователя.
 */
function cleanSweepResponse(rawText: string, stopTokens: string[]): string {
    let text = normalizeCrlf(rawText).replace(SWEEP_MARKERS, '').trimEnd();
    for (const stop of stopTokens) {
        const index = text.indexOf(stop);
        if (index >= 0) {
            text = text.slice(0, index).trimEnd();
        }
    }
    return text;
}

/**
 * Вычисляет минимальный диапазон замены между старым и новым окном пропуская общий prefix и suffix;
 * нужен чтобы правка была точечной и не затрагивала строки которые модель не изменила.
 */
function diffWindows(oldText: string, newText: string, windowStart: PositionDTO): TextEditDTO | undefined {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const oldLength = oldLines.length;
    const newLength = newLines.length;
    let prefix = 0;
    while (prefix < oldLength && prefix < newLength && oldLines[prefix] === newLines[prefix]) {
        prefix++;
    }
    let suffix = 0;
    while (
        suffix < oldLength - prefix &&
        suffix < newLength - prefix &&
        oldLines[oldLength - 1 - suffix] === newLines[newLength - 1 - suffix]
    ) {
        suffix++;
    }
    if (prefix === oldLength && prefix === newLength) {
        return undefined;
    }
    const oldEnd = oldLength - suffix;
    const newEnd = newLength - suffix;
    const replaceText = joinLineRange(newLines, prefix, newEnd);
    const replaceCount = newEnd - prefix;
    const endsBeforeRetainedLine = oldEnd < oldLength;
    return {
        range: {
            start: { line: windowStart.line + prefix, character: prefix === 0 ? windowStart.character : 0 },
            end: endPosition(windowStart, oldLines, oldEnd),
        },
        newText: replaceText + (endsBeforeRetainedLine && replaceCount > 0 ? '\n' : ''),
    };
}

function joinLineRange(lines: string[], start: number, endExclusive: number): string {
    if (start >= endExclusive) {
        return '';
    }
    let out = lines[start];
    for (let i = start + 1; i < endExclusive; i++) {
        out += `\n${lines[i]}`;
    }
    return out;
}

/**
 * Переводит эксклюзивный конец диапазона строк в документную позицию;
 * нужен потому что Monaco ожидает позицию конца а не индекс строки для замены.
 */
function endPosition(windowStart: PositionDTO, oldLines: string[], oldEnd: number): PositionDTO {
    if (oldEnd < oldLines.length) {
        return { line: windowStart.line + oldEnd, character: 0 };
    }
    const last = oldLines.length - 1;
    return { line: windowStart.line + last, character: oldLines[last]?.length ?? 0 };
}
