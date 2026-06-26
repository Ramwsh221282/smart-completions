import { Neighbor } from '../../../common/embedding-types';
import { DiagnosticDTO } from '../../../common/editor-dto';
import { RecentEdit } from '../../../common/edit-history-types';
import type { FileMode } from '../../../common/mode-types';
import { SweepLogger } from '../../../common/sweep/logger';
import type { SweepModelProfile } from '../../../common/sweep/profiles';
import { getSweepProfile } from '../../../common/sweep/profiles';
import { SweepEditVolume, SweepModelId, SweepOutputSnippet, SweepRelatedFile } from '../../../common/sweep/types';
import { normalizeCrlf } from '../../../common/text/crlf';
import { lineIndexAtOffset } from '../../../common/text/line-index';
import type { TokenCounter } from '../token-budget/token-counter';
import { charTokenEstimate } from '../token-budget/token-counter';

// Логгер триммера; нужен для диагностики что было обрезано и сколько символов осталось в бюджете.
const LOG = new SweepLogger('node:data-formatting:context-trimmer');
// Запас под разметку промпта: file_sep токены, заголовки блоков и служебные строки.
const SWEEP_TEMPLATE_OVERHEAD_TOKENS = 128;
// Минимальный бюджет на обязательную триаду, чтобы маленький ошибочный профиль не ломал сборку.
const SWEEP_MIN_BUDGET_TOKENS = 256;
// Максимум диагностик в промпте; больше не нужно, остальное шум.
const MAX_DIAGNOSTICS = 20;
// Радиус локальной error-диагностики вокруг курсора; этот сигнал чинит текущую правку.
const CURSOR_ERROR_RADIUS = 3;

// Полный набор данных для построения Sweep-промпта после сбора контекста на фронтенде.
export interface BuildSweepPromptInput {
    modelId: SweepModelId;
    filePath: string;
    fileMode?: FileMode;
    windowText: string;
    broadFileText?: string;
    broadFileStartLine?: number;
    cursorOffset: number;
    windowStartLine?: number;
    originalWindowText?: string;
    recentEdits: RecentEdit[];
    diagnostics?: DiagnosticDTO[];
    neighbors?: Neighbor[];
    relatedFiles?: SweepRelatedFile[];
    outline?: string;
    outputSnippets?: SweepOutputSnippet[];
    editVolume: SweepEditVolume;
    injectInlineDiagnostics?: boolean;
    prefill?: string;
    contextSize?: number;
    profile?: SweepModelProfile;
    requestModelName?: string;
    tokenCounter?: TokenCounter;
}

// Результат обрезки контекста; содержит только то что реально уместилось в бюджет токенов.
export interface TrimmedSweepContext {
    windowText: string;
    broadFileText: string;
    originalWindowText: string;
    cursorOffset: number;
    recentEdits: RecentEdit[];
    neighbors: Neighbor[];
    relatedFiles: SweepRelatedFile[];
    diagnostics: DiagnosticDTO[];
    outline: string;
    outputSnippets: SweepOutputSnippet[];
    prefill: string;
    overflow: boolean;
}

/**
 * Вычисляет доступный бюджет токенов вычитая резерв под генерацию и разметку промпта;
 * нужен чтобы суммарный prompt не превысил context window llama.cpp и не обрезал токены модели.
 */
function sweepTokenBudget(profile: SweepModelProfile, contextSize: number | undefined, maxTokens: number): number {
    const reserved = maxTokens + SWEEP_TEMPLATE_OVERHEAD_TOKENS;
    const effectiveContext = contextSize && contextSize > 0 ? Math.min(contextSize, profile.contextTokens) : profile.contextTokens;
    return Math.max(SWEEP_MIN_BUDGET_TOKENS, effectiveContext - reserved);
}

/**
 * Обрезает окно до maxTokens сохраняя курсор в центре; нужен чтобы модель всегда видела
 * позицию курсора независимо от размера файла и ограничений бюджета.
 */
function clampWindowAroundCursor(text: string, cursorOffset: number, maxTokens: number, counter?: TokenCounter): { text: string; cursorOffset: number } {
    const safeCursor = Math.max(0, Math.min(cursorOffset, text.length));
    if (tokenCost(text, counter) <= maxTokens) {
        return { text, cursorOffset: safeCursor };
    }
    let maxChars = Math.min(text.length, Math.max(1, maxTokens * 4));
    while (maxChars > 0) {
        const half = Math.floor(maxChars / 2);
        let start = Math.max(0, safeCursor - half);
        const end = Math.min(text.length, start + maxChars);
        start = Math.max(0, end - maxChars);
        const candidate = text.slice(start, end);
        if (tokenCost(candidate, counter) <= maxTokens) {
            return { text: candidate, cursorOffset: safeCursor - start };
        }
        maxChars = Math.floor(maxChars * 0.8);
    }
    return { text: '', cursorOffset: 0 };
}

/**
 * Идентифицирует error-диагностики потому что они никогда не обрезаются
 * и добавляются в промпт до более низкоприоритетного контекста.
 */
function isErrorSeverity(d: DiagnosticDTO): boolean {
    return d.severity === 'error';
}

/**
 * Идентифицирует warning-диагностики чтобы их можно было добавить после errors и истории правок,
 * но перед outline и output которые имеют ещё меньший приоритет.
 */
function isWarningSeverity(d: DiagnosticDTO): boolean {
    return d.severity === 'warning';
}

/**
 * Обрезает весь Sweep-контекст в порядке приоритета не трогая обязательную триаду original/current/updated;
 * порядок: local errors → recent edits → RAG/related → distant errors → warnings → outline → output.
 */
export function trimSweepContext(input: BuildSweepPromptInput, maxTokens: number): TrimmedSweepContext {
    const profile = input.profile ?? getSweepProfile(input.modelId === 'sweep-small' ? '1.5b' : 'v2-7b');
    const counter = input.tokenCounter;
    const budget = sweepTokenBudget(profile, input.contextSize, maxTokens);
    const windowBudget = Math.floor(budget * 0.4);

    const normalizedWindow = normalizeCrlf(input.windowText);
    const clamped = clampWindowAroundCursor(normalizedWindow, input.cursorOffset, windowBudget, counter);

    let originalWindow = input.originalWindowText !== undefined ? normalizeCrlf(input.originalWindowText) : clamped.text;
    if (tokenCost(originalWindow, counter) > windowBudget) {
        originalWindow = trimTextToTokenBudget(originalWindow, windowBudget, counter);
    }
    const prefill = input.prefill === undefined ? computeDefaultPrefill(clamped.text, clamped.cursorOffset) : normalizeCrlf(input.prefill);

    const diagnosticsEnabled = input.fileMode !== 'prose' && input.injectInlineDiagnostics !== false;
    let remaining = budget - tokenCost(clamped.text, counter) - tokenCost(originalWindow, counter) - tokenCost(prefill, counter);
    const overflow = clamped.text.trim().length === 0 || remaining < 0;

    let broadFileText = '';
    const broadCandidate = normalizeCrlf(input.broadFileText ?? '');
    if (broadCandidate) {
        const broadBudget = Math.max(1, Math.floor(remaining * 0.55));
        broadFileText = trimTextToTokenBudget(broadCandidate, broadBudget, counter);
        remaining -= tokenCost(broadFileText, counter);
    }

    const diagnosticsInput = diagnosticsEnabled ? input.diagnostics ?? [] : [];
    const diagnosticsCount = Math.min(diagnosticsInput.length, MAX_DIAGNOSTICS);
    const errorDiagnostics: DiagnosticDTO[] = [];
    const warningDiagnostics: DiagnosticDTO[] = [];
    for (let i = 0; i < diagnosticsCount; i++) {
        const diagnostic = diagnosticsInput[i];
        if (isErrorSeverity(diagnostic)) {
            errorDiagnostics.push(diagnostic);
        } else if (isWarningSeverity(diagnostic)) {
            warningDiagnostics.push(diagnostic);
        }
    }
    const cursorDocLine = (input.windowStartLine ?? 0) + lineIndexAtOffset(clamped.text, clamped.cursorOffset);
    const localErrors: DiagnosticDTO[] = [];
    const distantErrors: DiagnosticDTO[] = [];
    for (let i = 0; i < errorDiagnostics.length; i++) {
        const diagnostic = errorDiagnostics[i];
        if (Math.abs(diagnostic.range.start.line - cursorDocLine) <= CURSOR_ERROR_RADIUS) {
            localErrors.push(diagnostic);
        } else {
            distantErrors.push(diagnostic);
        }
    }

    const keptDiagnostics: DiagnosticDTO[] = [];
    // Вспомогательная функция берёт диагностики пока хватает бюджета; вызывается дважды для errors и warnings.
    const takeDiagnostics = (list: DiagnosticDTO[], phase: string): void => {
        for (const diagnostic of list) {
            const cost = tokenCost(diagnostic.message, counter) + 8;
            if (cost <= remaining) {
                keptDiagnostics.push(diagnostic);
                remaining -= cost;
            } else {
                if (process.env.NODE_ENV === 'development') {
                    LOG.debug('Sweep diagnostic trimmed by budget', { phase, cost, remaining, message: diagnostic.message });
                }
            }
        }
    };

    takeDiagnostics(localErrors, 'local-errors');

    // История правок сортируется от новейшей к старейшей чтобы при обрезке терялись менее актуальные диффы.
    const editsNewestFirst = input.recentEdits.slice().sort((a, b) => b.timestamp - a.timestamp);
    const keptEdits: RecentEdit[] = [];
    for (const edit of editsNewestFirst) {
        const cost = tokenCost(normalizeCrlf(edit.unifiedDiff), counter) + tokenCost(edit.uri, counter) + 8;
        if (cost <= remaining) {
            keptEdits.push(edit);
            remaining -= cost;
        } else {
            if (process.env.NODE_ENV === 'development') {
                LOG.debug('Sweep recent edit trimmed by budget', { uri: edit.uri, cost, remaining });
            }
            break;
        }
    }

    // RAG-соседи сортируются по убыванию релевантности чтобы при обрезке терялись наименее точные.
    const neighborsByScore = (input.neighbors ?? []).slice().sort((a, b) => b.score - a.score);
    const keptNeighbors: Neighbor[] = [];
    for (const neighbor of neighborsByScore) {
        const cost = tokenCost(neighbor.text, counter) + tokenCost(neighbor.filePath, counter) + 8;
        if (cost <= remaining) {
            keptNeighbors.push(neighbor);
            remaining -= cost;
        } else {
            if (process.env.NODE_ENV === 'development') {
                LOG.debug('Sweep RAG neighbor trimmed by budget', { filePath: neighbor.filePath, cost, remaining });
            }
            break;
        }
    }

    const keptRelated: SweepRelatedFile[] = [];
    for (const related of input.relatedFiles ?? []) {
        const cost = tokenCost(related.content, counter) + tokenCost(related.filePath, counter) + 8;
        if (cost <= remaining) {
            keptRelated.push(related);
            remaining -= cost;
        } else {
            if (process.env.NODE_ENV === 'development') {
                LOG.debug('Sweep related file trimmed by budget', { filePath: related.filePath, cost, remaining });
            }
            break;
        }
    }

    takeDiagnostics(distantErrors, 'distant-errors');
    takeDiagnostics(warningDiagnostics, 'warnings');

    let outline = '';
    const outlineCandidate = normalizeCrlf(input.outline ?? '').trim();
    const outlineCost = tokenCost(outlineCandidate, counter) + 8;
    if (outlineCandidate && outlineCost <= remaining) {
        outline = outlineCandidate;
        remaining -= outlineCost;
    } else if (outlineCandidate) {
        if (process.env.NODE_ENV === 'development') {
            LOG.debug('Sweep outline trimmed by budget', { cost: outlineCost, remaining });
        }
    }

    const keptOutput: SweepOutputSnippet[] = [];
    for (const snippet of input.outputSnippets ?? []) {
        const cost = tokenCost(snippet.text, counter) + tokenCost(snippet.channel, counter) + 8;
        if (cost <= remaining) {
            keptOutput.push(snippet);
            remaining -= cost;
        } else {
            if (process.env.NODE_ENV === 'development') {
                LOG.debug('Sweep output snippet trimmed by budget', { channel: snippet.channel, cost, remaining });
            }
            break;
        }
    }

    LOG.info('Sweep context trimmed', {
        modelId: input.modelId,
        contextProfile: profile.id,
        contextTokens: profile.contextTokens,
        effectiveContextTokens: input.contextSize && input.contextSize > 0 ? Math.min(input.contextSize, profile.contextTokens) : profile.contextTokens,
        tokenCounterMode: counter?.mode ?? 'char-fallback',
        maxTokens,
        budget,
        remaining,
        overflow,
        broadFileTokens: tokenCost(broadFileText, counter),
        windowTokens: tokenCost(clamped.text, counter),
        originalTokens: tokenCost(originalWindow, counter),
        recentEditsIn: input.recentEdits.length,
        recentEditsOut: keptEdits.length,
        diagnosticsIn: diagnosticsCount,
        diagnosticsOut: keptDiagnostics.length,
        localErrorsIn: localErrors.length,
        distantErrorsIn: distantErrors.length,
        neighborsIn: input.neighbors?.length ?? 0,
        neighborsOut: keptNeighbors.length,
        relatedIn: input.relatedFiles?.length ?? 0,
        relatedOut: keptRelated.length,
        outlineChars: outline.length,
        outputOut: keptOutput.length,
        prefillTokens: tokenCost(prefill, counter),
    });

    return {
        windowText: clamped.text,
        broadFileText,
        originalWindowText: originalWindow,
        cursorOffset: clamped.cursorOffset,
        recentEdits: keptEdits,
        neighbors: keptNeighbors,
        relatedFiles: keptRelated,
        diagnostics: keptDiagnostics,
        outline,
        outputSnippets: keptOutput,
        prefill,
        overflow,
    };
}

function tokenCost(text: string, counter?: TokenCounter): number {
    return counter ? counter.count(text) : charTokenEstimate(text);
}

function trimTextToTokenBudget(text: string, maxTokens: number, counter?: TokenCounter): string {
    if (tokenCost(text, counter) <= maxTokens) {
        return text;
    }
    let maxChars = Math.min(text.length, Math.max(1, maxTokens * 4));
    while (maxChars > 0) {
        const candidate = text.slice(0, maxChars);
        if (tokenCost(candidate, counter) <= maxTokens) {
            return candidate;
        }
        maxChars = Math.floor(maxChars * 0.8);
    }
    return '';
}

/** Default Sweep prefill preserves lines above the cursor so generation starts at the editable cursor line. */
function computeDefaultPrefill(text: string, cursorOffset: number): string {
    const safeCursor = Math.max(0, Math.min(cursorOffset, text.length));
    const lineStart = text.lastIndexOf('\n', safeCursor - 1) + 1;
    return lineStart > 0 ? text.slice(0, lineStart) : '';
}
