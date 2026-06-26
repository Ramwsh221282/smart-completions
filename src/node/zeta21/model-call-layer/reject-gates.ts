import { countLines } from '../../../common/text/line-index';
import { normalizeCrlf } from '../../../common/text/crlf';

// Компилируется один раз вне функции и используется в whitespace-гейте без лишних аллокаций на каждый регион.
const WHITESPACE = /\s+/g;

/** Последовательно прогоняет zeta21 reject-гейты для одного региона и возвращает причину отказа, если правка выглядит как drift. */
export function zetaRejectReason(oldRegionText: string, updatedRegionText: string): string | undefined {
    const oldText = normalizeCrlf(oldRegionText);
    const newText = normalizeCrlf(updatedRegionText);
    if (sameWithoutWhitespace(oldText, newText)) {
        return 'whitespace-only';
    }
    const oldLineCount = countLines(oldText);
    const newLineCount = countLines(newText);
    if (windowShapeRejected(oldLineCount, newLineCount)) {
        return 'window-shape';
    }
    if (editVolumeRejected(oldLineCount, newLineCount)) {
        return 'edit-volume';
    }
    return undefined;
}

function sameWithoutWhitespace(oldText: string, newText: string): boolean {
    return oldText !== newText && oldText.replace(WHITESPACE, '') === newText.replace(WHITESPACE, '');
}

function windowShapeRejected(oldLineCount: number, newLineCount: number): boolean {
    const maxGrowth = Math.max(8, oldLineCount);
    const minLines = Math.max(1, Math.floor(oldLineCount * 0.25));
    return newLineCount > oldLineCount + maxGrowth || newLineCount < minLines;
}

function editVolumeRejected(oldLineCount: number, newLineCount: number): boolean {
    const touchedLines = Math.max(oldLineCount, newLineCount);
    const limit = Math.max(12, Math.ceil(oldLineCount * 0.75));
    return touchedLines > limit;
}
