import { Neighbor } from '../../../common/embedding-types';
import { DiagnosticDTO } from '../../../common/editor-dto';
import { RecentEdit } from '../../../common/edit-history-types';
import { NesEditVolume, NesRelatedFile } from '../../../common/nes-types';
import { NesModelId } from '../../../common/model-types';
import { normalizeCrlf, splitLines } from '../../util/crlf';
import { buildSweepPrompt as buildSweepPromptFromLayer } from '../../sweep/prompt-creating-layer/sweep-prompt-builder';

/** Связанный файл (RAG-сосед или результат LSP/search), отдаётся нативным file-блоком. */
export type RelatedFile = NesRelatedFile;

export interface BuildNesPromptInput {
    modelId: NesModelId;
    filePath: string;
    windowText: string;
    cursorOffset: number;
    /** 0-based строка документа, с которой начинается windowText (для заголовков original/current/updated). */
    windowStartLine?: number;
    /** Окно у курсора ДО последней правки (Зона D, original/). Нет — берётся текущее окно. */
    originalWindowText?: string;
    recentEdits: RecentEdit[];
    diagnostics?: DiagnosticDTO[];
    neighbors?: Neighbor[];
    /** Связанные файлы из LSP/search — нативные file-блоки в зоне контекста. */
    relatedFiles?: RelatedFile[];
    /** Компактная outline-карта текущего файла (Зона B). */
    outline?: string;
    editVolume: NesEditVolume;
    /** Sweep: положить diagnostics pseudo-file. false — выключить. undefined — включено. */
    injectInlineDiagnostics?: boolean;
    /** Префилл в updated/ (Зона D). По умолчанию пусто: модель генерирует всё окно. */
    prefill?: string;
    /** Окно контекста модели в токенах. Промпт обрезается, чтобы в него поместиться. */
    contextSize?: number;
}

export interface BuiltNesPrompt {
    prompt: string;
    stop: string[];
    maxTokens: number;
    model: string;
    format: 'sweep' | 'zeta-2.1';
    /** true — обязательное ядро (original/current/updated) не помещается в окно модели; подсказку не делаем. */
    overflow: boolean;
}

const CHARS_PER_TOKEN = 4;
const NES_MIN_BUDGET_CHARS = 512;
const NES_TEMPLATE_OVERHEAD_CHARS = 512;
const DEFAULT_NES_CONTEXT_SIZE = 16384;
const MAX_DIAGNOSTICS = 20;

export function buildNesPrompt(input: BuildNesPromptInput): BuiltNesPrompt {
    const maxTokens = maxTokensForVolume(input.editVolume);
    const trimmed = trimNesContext(input, maxTokens);
    switch (input.modelId) {
        case 'zeta-2.1':
            return buildZeta21Prompt(input, trimmed, maxTokens);
        default:
            return buildSweepPromptFromLayer({ ...input, modelId: input.modelId === 'sweep-small' ? 'sweep-small' : 'sweep-default' });
    }
}

/** Недавние правки без заголовков diff — для zeta 2.0. */
export function formatRecentEdits(edits: RecentEdit[], maxChars = 6000): string {
    const text = edits
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(edit => `File: ${edit.uri}\n${stripDiffHeader(normalizeCrlf(edit.unifiedDiff))}`)
        .join('\n\n');
    return text.length > maxChars ? text.slice(-maxChars) : text;
}

/** Недавние правки С заголовками diff — нативный формат edit_history Zeta 2.1. */
export function formatRecentEditsWithHeaders(edits: RecentEdit[], maxChars = 6000): string {
    const text = edits
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(edit => normalizeCrlf(edit.unifiedDiff))
        .join('\n\n');
    return text.length > maxChars ? text.slice(-maxChars) : text;
}

/**
 * Разбор сохранённого unified diff на состояния «до»/«после».
 * Контекстные строки (' ') попадают в обе стороны, '-' — в original, '+' — в updated.
 */
export function unifiedDiffToOriginalUpdated(diff: string): { original: string; updated: string } {
    const original: string[] = [];
    const updated: string[] = [];
    for (const line of splitLines(diff)) {
        if (
            line.startsWith('--- ') ||
            line.startsWith('+++ ') ||
            line.startsWith('@@') ||
            line.startsWith('Index: ') ||
            line.startsWith('===')
        ) {
            continue;
        }
        if (line.startsWith('-')) {
            original.push(line.slice(1));
        } else if (line.startsWith('+')) {
            updated.push(line.slice(1));
        } else if (line.startsWith(' ')) {
            original.push(line.slice(1));
            updated.push(line.slice(1));
        } else {
            original.push(line);
            updated.push(line);
        }
    }
    return { original: original.join('\n'), updated: updated.join('\n') };
}

interface TrimmedNesContext {
    windowText: string;
    originalWindowText: string;
    cursorOffset: number;
    recentEdits: RecentEdit[];
    neighbors: Neighbor[];
    relatedFiles: RelatedFile[];
    diagnostics: DiagnosticDTO[];
    outline: string;
    prefill: string;
    overflow: boolean;
}

function nesCharBudget(contextSize: number, maxTokens: number): number {
    const reserved = maxTokens * CHARS_PER_TOKEN + NES_TEMPLATE_OVERHEAD_CHARS;
    return Math.max(NES_MIN_BUDGET_CHARS, contextSize * CHARS_PER_TOKEN - reserved);
}

// Удерживает окно у курсора в пределах maxChars символов, центрируя на курсоре.
function clampWindowAroundCursor(text: string, cursorOffset: number, maxChars: number): { text: string; cursorOffset: number } {
    const safeCursor = Math.max(0, Math.min(cursorOffset, text.length));
    if (text.length <= maxChars) {
        return { text, cursorOffset: safeCursor };
    }
    const half = Math.floor(maxChars / 2);
    let start = Math.max(0, safeCursor - half);
    const end = Math.min(text.length, start + maxChars);
    start = Math.max(0, end - maxChars);
    return { text: text.slice(start, end), cursorOffset: safeCursor - start };
}

function isErrorSeverity(d: DiagnosticDTO): boolean {
    return d.severity === 'error';
}

function isWarningSeverity(d: DiagnosticDTO): boolean {
    return d.severity === 'warning';
}

// Наполнение по приоритету (что НЕ режется — первым): обязательная триада
// original/current/updated → diagnostics errors → свежие правки → RAG/связанные файлы →
// diagnostics warnings → outline. Превышение бюджета режет в обратном порядке.
function trimNesContext(input: BuildNesPromptInput, maxTokens: number): TrimmedNesContext {
    const contextSize = input.contextSize && input.contextSize > 0 ? input.contextSize : DEFAULT_NES_CONTEXT_SIZE;
    const budget = nesCharBudget(contextSize, maxTokens);
    const halfBudget = Math.floor(budget / 2);

    const normalizedWindow = normalizeCrlf(input.windowText);
    const clamped = clampWindowAroundCursor(normalizedWindow, input.cursorOffset, halfBudget);

    let originalWindow = input.originalWindowText !== undefined ? normalizeCrlf(input.originalWindowText) : clamped.text;
    if (originalWindow.length > halfBudget) {
        originalWindow = originalWindow.slice(0, halfBudget);
    }
    const prefill = normalizeCrlf(input.prefill ?? '');

    const diagnosticsEnabled =
        (input.modelId === 'sweep-default' || input.modelId === 'sweep-small') && input.injectInlineDiagnostics !== false;

    let remaining = budget - clamped.text.length - originalWindow.length - prefill.length;
    const overflow = clamped.text.trim().length === 0 || remaining < 0;

    const allDiagnostics = diagnosticsEnabled ? (input.diagnostics ?? []).slice(0, MAX_DIAGNOSTICS) : [];
    const errorDiagnostics = allDiagnostics.filter(isErrorSeverity);
    const warningDiagnostics = allDiagnostics.filter(isWarningSeverity);

    const keptDiagnostics: DiagnosticDTO[] = [];
    const takeDiagnostics = (list: DiagnosticDTO[]): void => {
        for (const diagnostic of list) {
            const cost = diagnostic.message.length + 24;
            if (cost <= remaining) {
                keptDiagnostics.push(diagnostic);
                remaining -= cost;
            }
        }
    };

    // 1) diagnostics errors — высший приоритет после обязательного окна.
    takeDiagnostics(errorDiagnostics);

    // 2) свежие правки (новые первыми).
    const editsNewestFirst = input.recentEdits.slice().sort((a, b) => b.timestamp - a.timestamp);
    const keptEdits: RecentEdit[] = [];
    for (const edit of editsNewestFirst) {
        const cost = normalizeCrlf(edit.unifiedDiff).length + edit.uri.length + 24;
        if (cost <= remaining) {
            keptEdits.push(edit);
            remaining -= cost;
        } else {
            break;
        }
    }

    // 3) RAG-соседи и связанные файлы (по score / порядку).
    const neighborsByScore = (input.neighbors ?? []).slice().sort((a, b) => b.score - a.score);
    const keptNeighbors: Neighbor[] = [];
    for (const neighbor of neighborsByScore) {
        const cost = neighbor.text.length + neighbor.filePath.length + 24;
        if (cost <= remaining) {
            keptNeighbors.push(neighbor);
            remaining -= cost;
        } else {
            break;
        }
    }
    const keptRelated: RelatedFile[] = [];
    for (const related of input.relatedFiles ?? []) {
        const cost = related.content.length + related.filePath.length + 24;
        if (cost <= remaining) {
            keptRelated.push(related);
            remaining -= cost;
        } else {
            break;
        }
    }

    // 4) diagnostics warnings.
    takeDiagnostics(warningDiagnostics);

    // 5) outline.
    let outline = '';
    const outlineCandidate = normalizeCrlf(input.outline ?? '').trim();
    if (outlineCandidate && outlineCandidate.length + 24 <= remaining) {
        outline = outlineCandidate;
        remaining -= outlineCandidate.length + 24;
    }

    return {
        windowText: clamped.text,
        originalWindowText: originalWindow,
        cursorOffset: clamped.cursorOffset,
        recentEdits: keptEdits,
        neighbors: keptNeighbors,
        relatedFiles: keptRelated,
        diagnostics: keptDiagnostics,
        outline,
        prefill,
        overflow,
    };
}

// Sweep training-формат: нативные file-блоки контекста и pseudo-file для outline/diagnostics,
// recent changes как {path}.diff, и обязательная триада original/current/updated в самом конце —
// модель генерирует из updated/, поэтому он замыкает промпт.
function buildSweepPrompt(input: BuildNesPromptInput, trimmed: TrimmedNesContext, maxTokens: number): BuiltNesPrompt {
    const sections: string[] = [];

    // Зона A — контекст файлов (нативно).
    for (const neighbor of trimmed.neighbors) {
        sections.push(`<|file_sep|>${neighbor.filePath}\n${normalizeCrlf(neighbor.text)}`);
    }
    for (const related of trimmed.relatedFiles) {
        sections.push(`<|file_sep|>${related.filePath}\n${normalizeCrlf(related.content)}`);
    }

    // Зона B — ситуативные сигналы (pseudo-files).
    if (trimmed.outline) {
        sections.push(`<|file_sep|>outline/${input.filePath}\n${trimmed.outline}`);
    }
    if (trimmed.diagnostics.length > 0) {
        sections.push(`<|file_sep|>diagnostics/${input.filePath}\n${formatDiagnosticsLines(trimmed.diagnostics)}`);
    }

    // Зона C — сигнал правки (нативный diff).
    for (const block of formatDiffBlocks(trimmed.recentEdits)) {
        sections.push(block);
    }

    // Зона D — задача (нативно, фикс, всегда последняя): original/ → current/ → updated/.
    const currentWindow = insertCursor(trimmed.windowText, trimmed.cursorOffset, '<|cursor|>');
    const range = windowRange(input.windowStartLine ?? 0, trimmed.windowText);
    sections.push(`<|file_sep|>original/${input.filePath}:${range}\n${trimmed.originalWindowText}`);
    sections.push(`<|file_sep|>current/${input.filePath}:${range}\n${currentWindow}`);
    sections.push(`<|file_sep|>updated/${input.filePath}:${range}\n${trimmed.prefill}`);

    return {
        prompt: sections.join('\n'),
        stop: ['<|file_sep|>', '<|endoftext|>'],
        maxTokens,
        model: input.modelId === 'sweep-small' ? 'sweep-next-edit-small' : 'sweep-next-edit-v2',
        format: 'sweep',
        overflow: trimmed.overflow,
    };
}

// Нативный промпт Zeta 2.1 (SPM, multi-region markers). editable region = всё окно.
// Слоты: <[fim-suffix]> · related files · edit_history (с заголовками) · target file ·
// <|marker_1|>…<|marker_2|> · <|user_cursor|> · <[fim-middle]>.
function buildZeta21Prompt(input: BuildNesPromptInput, trimmed: TrimmedNesContext, maxTokens: number): BuiltNesPrompt {
    const region = insertCursor(trimmed.windowText, trimmed.cursorOffset, '<|user_cursor|>');
    const prefixSections: string[] = [];
    for (const neighbor of trimmed.neighbors) {
        prefixSections.push(`<filename>${neighbor.filePath}\n${normalizeCrlf(neighbor.text)}`);
    }
    prefixSections.push(`<filename>edit_history\n${formatRecentEditsWithHeaders(trimmed.recentEdits)}`);
    prefixSections.push(`<filename>${input.filePath}\n<|marker_1|>\n${region}\n<|marker_2|>`);
    const prefixStream = `<[fim-prefix]>${prefixSections.join('\n\n')}`;
    const prompt = ['<[fim-suffix]>', prefixStream, '<[fim-middle]>'].join('\n');
    return {
        prompt,
        stop: ['<|marker_2|>', '<[fim-suffix]>', '<|endoftext|>', '<|end_of_text|>'],
        maxTokens,
        model: 'zeta',
        format: 'zeta-2.1',
        overflow: trimmed.overflow,
    };
}

function insertCursor(text: string, offset: number, token: string): string {
    const safeOffset = Math.max(0, Math.min(offset, text.length));
    return `${text.slice(0, safeOffset)}${token}${text.slice(safeOffset)}`;
}

// Recent changes как нативные {path}.diff блоки с состояниями original:/updated:.
function formatDiffBlocks(edits: RecentEdit[]): string[] {
    return edits
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(edit => {
            const { original, updated } = unifiedDiffToOriginalUpdated(edit.unifiedDiff);
            return `<|file_sep|>${edit.uri}.diff\noriginal:\n${original}\nupdated:\n${updated}`;
        });
}

function stripDiffHeader(diff: string): string {
    return diff
        .split('\n')
        .filter(line => !line.startsWith('Index: ') && !line.startsWith('--- ') && !line.startsWith('+++ ') && !line.startsWith('==='))
        .join('\n');
}

function formatNeighbors(neighbors: Neighbor[]): string {
    return neighbors.map(neighbor => `File: ${neighbor.filePath}:${neighbor.startLine}-${neighbor.endLine}\n${normalizeCrlf(neighbor.text)}`).join('\n\n');
}

// diagnostics pseudo-file: errors раньше warnings, формат «Line N: message».
function formatDiagnosticsLines(diagnostics: DiagnosticDTO[]): string {
    const errorsFirst = diagnostics
        .slice()
        .sort((a, b) => severityRank(a) - severityRank(b) || a.range.start.line - b.range.start.line);
    return errorsFirst.map(d => `Line ${d.range.start.line + 1}: ${d.message}`).join('\n');
}

function severityRank(d: DiagnosticDTO): number {
    return d.severity === 'error' ? 0 : d.severity === 'warning' ? 1 : 2;
}

function windowRange(startLine0: number, windowText: string): string {
    const start = startLine0 + 1;
    const end = startLine0 + lineCount(windowText);
    return `${start}:${end}`;
}

function lineCount(text: string): number {
    return splitLines(text).length;
}

function maxTokensForVolume(volume: NesEditVolume): number {
    switch (volume) {
        case 'small':
            return 128;
        case 'large':
            return 512;
        default:
            return 256;
    }
}
