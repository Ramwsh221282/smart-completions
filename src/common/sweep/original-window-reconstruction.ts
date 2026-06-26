import type { RecentEdit } from '../edit-history-types';
import { normalizeCrlf, splitLines } from '../text/crlf';

// Регулярка для заголовка unified diff hunk; компилируется один раз вне функции чтобы не пересоздавать при каждом вызове парсера.
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Разобранный хунк unified diff; отдельная форма нужна чтобы reverseApplyHunk работал со стабильными типами без dynamic lookup.
interface ParsedHunk {
    oldStartLine0: number;
    oldLineCount: number;
    newStartLine0: number;
    newLineCount: number;
    originalLines: string[];
    updatedLines: string[];
}

/**
 * Реконструирует до-правочное окно триады когда снапшот из EditHistoryStore недоступен
 * (timing race после flush или перезагрузка редактора): ищет последний diff, пересекающий окно,
 * и обращает его применение, чтобы original/ ≠ current/ и модель видела трансформацию.
 */
export function reconstructOriginalWindow(currentWindowText: string, windowStartLine0: number, uri: string, recentEdits: RecentEdit[]): string | undefined {
    const currentLines = splitLines(normalizeCrlf(currentWindowText));
    const windowEndExclusive = windowStartLine0 + currentLines.length;
    for (let i = recentEdits.length - 1; i >= 0; i--) {
        const edit = recentEdits[i];
        if (edit.uri !== uri) {
            continue;
        }
        const hunks = parseUnifiedDiffHunks(edit.unifiedDiff);
        for (let j = hunks.length - 1; j >= 0; j--) {
            const hunk = hunks[j];
            if (!hunkOverlapsWindow(hunk, windowStartLine0, windowEndExclusive)) {
                continue;
            }
            const reconstructed = reverseApplyHunk(currentLines, windowStartLine0, hunk);
            if (reconstructed !== undefined && reconstructed !== currentWindowText) {
                return reconstructed;
            }
        }
    }
    return undefined;
}

/**
 * Разбирает unified diff на список хунков; нужен потому что EditHistoryStore хранит compact
 * unified diff, а reverseApplyHunk работает с одним хунком за раз для точечного реверса.
 */
function parseUnifiedDiffHunks(diff: string): ParsedHunk[] {
    const lines = splitLines(normalizeCrlf(diff));
    const hunks: ParsedHunk[] = [];
    let current: ParsedHunk | null = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = HUNK_HEADER.exec(line);
        if (match !== null) {
            current = createHunk(match);
            hunks.push(current);
            continue;
        }
        if (current === null || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('Index: ') || line.startsWith('===')) {
            continue;
        }
        appendDiffLine(current, line);
    }
    return hunks;
}

/**
 * Фабрика хунка из RegExp-матча заголовка; выделена чтобы функция была мономорфной
 * и V8 не менял hidden class ParsedHunk после инициализации.
 */
function createHunk(match: RegExpExecArray): ParsedHunk {
    return {
        oldStartLine0: Number(match[1]) - 1,
        oldLineCount: hunkCount(match[2]),
        newStartLine0: Number(match[3]) - 1,
        newLineCount: hunkCount(match[4]),
        originalLines: [],
        updatedLines: [],
    };
}

// Разбирает опциональное поле count из заголовка; в unified diff count=1 записывается как отсутствие «,N» после номера строки.
function hunkCount(raw: string | undefined): number {
    return raw === undefined ? 1 : Number(raw);
}

/**
 * Добавляет строку diff в нужный список хунка на месте; мутация существующего объекта
 * вместо создания нового убирает лишние аллокации при разборе каждой строки.
 */
function appendDiffLine(hunk: ParsedHunk, line: string): void {
    if (line.startsWith('-')) {
        hunk.originalLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
        hunk.updatedLines.push(line.slice(1));
    } else if (line.startsWith(' ')) {
        const text = line.slice(1);
        hunk.originalLines.push(text);
        hunk.updatedLines.push(text);
    } else {
        hunk.originalLines.push(line);
        hunk.updatedLines.push(line);
    }
}

// Проверяет пересечение хунка с окном триады; только пересекающиеся хунки могут объяснить разницу между current и pre-edit состоянием.
function hunkOverlapsWindow(hunk: ParsedHunk, windowStartLine0: number, windowEndExclusive: number): boolean {
    const hunkStart = hunk.newStartLine0;
    const hunkEnd = hunk.newStartLine0 + hunk.newLineCount;
    return hunk.newLineCount === 0
        ? hunkStart >= windowStartLine0 && hunkStart <= windowEndExclusive
        : hunkStart < windowEndExclusive && hunkEnd > windowStartLine0;
}

/**
 * Применяет обратное изменение хунка к current-окну; сначала верифицирует что updated-строки
 * хунка совпадают с current, иначе возвращает undefined — реконструкция невозможна без matching.
 */
function reverseApplyHunk(currentLines: string[], windowStartLine0: number, hunk: ParsedHunk): string | undefined {
    const offset = hunk.newStartLine0 - windowStartLine0;
    if (offset < 0 || offset > currentLines.length) {
        return undefined;
    }
    if (offset + hunk.newLineCount > currentLines.length) {
        return undefined;
    }
    for (let i = 0; i < hunk.updatedLines.length; i++) {
        if (currentLines[offset + i] !== hunk.updatedLines[i]) {
            return undefined;
        }
    }
    const reconstructed = new Array<string>(currentLines.length - hunk.newLineCount + hunk.originalLines.length);
    let out = 0;
    for (let i = 0; i < offset; i++) {
        reconstructed[out++] = currentLines[i];
    }
    for (let i = 0; i < hunk.originalLines.length; i++) {
        reconstructed[out++] = hunk.originalLines[i];
    }
    for (let i = offset + hunk.newLineCount; i < currentLines.length; i++) {
        reconstructed[out++] = currentLines[i];
    }
    return reconstructed.join('\n');
}
