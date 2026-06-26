import type { ZetaEditableRegion } from './types';

// Регулярка маркера компилируется один раз вне горячего пути, чтобы парсер ответа не создавал RegExp на каждый completion.
const MARKER_RE = /<\|marker_(\d+)\|>/g;

// Границы синтаксически расширенного региона задаются в offset-ах windowText, чтобы request builder не таскал Monaco Range на backend.
export interface RegionBounds {
    start: number;
    end: number;
}

// Вход buildRegions допускает один bounds, несколько bounds или null, чтобы request builder мог отдавать и line fallback, и multi-region цели.
export interface BuildRegionsInput {
    windowText: string;
    cursorOffset: number;
    syntacticBounds: RegionBounds | RegionBounds[] | null;
}

/** Строит список редактируемых регионов из синтаксических границ или line-wise fallback, сохраняя стабильную нумерацию marker_1/2/3/4. */
export function buildRegions(input: BuildRegionsInput): ZetaEditableRegion[] {
    const bounds = normalizeBounds(input.syntacticBounds, input.windowText.length);
    if (bounds.length === 0) {
        const line = lineBoundsAt(input.windowText, input.cursorOffset);
        return [{ markerIndex: 1, startOffset: line.start, endOffset: line.end }];
    }
    const out = new Array<ZetaEditableRegion>(bounds.length);
    for (let i = 0; i < bounds.length; i++) {
        out[i] = { markerIndex: i * 2 + 1, startOffset: bounds[i].start, endOffset: bounds[i].end };
    }
    return out;
}

/** Вставляет нумерованные marker'ы и `<|user_cursor|>` в окно слева направо, чтобы prompt builder держал один источник truth для region-разметки. */
export function renderRegions(windowText: string, regions: ZetaEditableRegion[], cursorOffset: number): string {
    const safeCursor = clampOffset(cursorOffset, windowText.length);
    if (regions.length === 0) {
        return insertCursor(windowText, safeCursor);
    }
    const ordered = regions.slice().sort((a, b) => a.startOffset - b.startOffset);
    const parts: string[] = [];
    let pos = 0;
    let cursorInserted = false;
    for (let i = 0; i < ordered.length; i++) {
        const region = ordered[i];
        cursorInserted = pushSegment(parts, windowText, pos, region.startOffset, safeCursor, false, cursorInserted);
        parts.push(`<|marker_${region.markerIndex}|>`);
        cursorInserted = pushSegment(parts, windowText, region.startOffset, region.endOffset, safeCursor, true, cursorInserted);
        parts.push(`<|marker_${region.markerIndex + 1}|>`);
        pos = region.endOffset;
    }
    pushSegment(parts, windowText, pos, windowText.length, safeCursor, true, cursorInserted);
    return parts.join('');
}

/** Собирает marker indices из ответа модели, чтобы тесты и парсер могли валидировать парность и порядок регионов. */
export function collectMarkerIndices(text: string): number[] {
    MARKER_RE.lastIndex = 0;
    const out: number[] = [];
    for (let match = MARKER_RE.exec(text); match; match = MARKER_RE.exec(text)) {
        out.push(Number(match[1]));
    }
    return out;
}

function insertCursor(text: string, cursorOffset: number): string {
    return `${text.slice(0, cursorOffset)}<|user_cursor|>${text.slice(cursorOffset)}`;
}

function pushSegment(parts: string[], text: string, from: number, to: number, cursorOffset: number, includeEnd: boolean, cursorInserted: boolean): boolean {
    if (cursorInserted || cursorOffset < from || cursorOffset > to || (!includeEnd && cursorOffset === to)) {
        parts.push(text.slice(from, to));
        return cursorInserted;
    }
    parts.push(text.slice(from, cursorOffset));
    parts.push('<|user_cursor|>');
    parts.push(text.slice(cursorOffset, to));
    return true;
}

function normalizeBounds(input: RegionBounds | RegionBounds[] | null, textLength: number): RegionBounds[] {
    const raw = input === null ? [] : Array.isArray(input) ? input : [input];
    if (raw.length === 0) {
        return [];
    }
    const ordered = new Array<RegionBounds>(raw.length);
    for (let i = 0; i < raw.length; i++) {
        const start = clampOffset(raw[i].start, textLength);
        const end = clampOffset(raw[i].end, textLength);
        ordered[i] = start <= end ? { start, end } : { start: end, end: start };
    }
    ordered.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: RegionBounds[] = [ordered[0]];
    for (let i = 1; i < ordered.length; i++) {
        const current = ordered[i];
        const previous = merged[merged.length - 1];
        if (current.start <= previous.end) {
            if (current.end > previous.end) {
                previous.end = current.end;
            }
            continue;
        }
        merged.push(current);
    }
    return merged;
}

function lineBoundsAt(text: string, offset: number): RegionBounds {
    const safeOffset = clampOffset(offset, text.length);
    let start = safeOffset;
    while (start > 0 && text.charCodeAt(start - 1) !== 10) {
        start--;
    }
    let end = safeOffset;
    while (end < text.length && text.charCodeAt(end) !== 10) {
        end++;
    }
    return { start, end };
}

function clampOffset(offset: number, textLength: number): number {
    return Math.max(0, Math.min(offset, textLength));
}
