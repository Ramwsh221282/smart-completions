import type { RecentEdit } from '../../../common/edit-history-types';
import { normalizeCrlf } from '../../../common/text/crlf';
import { ZetaLogger } from '../../../common/zeta21/logger';
import type { ZetaModelProfile } from '../../../common/zeta21/profiles';
import type { ZetaEditableRegion, ZetaRelatedFile } from '../../../common/zeta21/types';
import type { TokenCounter } from '../token-budget/token-counter';
import { charTokenEstimate } from '../token-budget/token-counter';

// Логгер триммера нужен чтобы видеть сколько контекста сохранилось в zeta21 SPM-зонах и где ушёл бюджет.
const LOG = new ZetaLogger('node:data-formatting:context-trimmer');

// Запас под спец-токены, заголовки `<filename>` и служебные разделители Zeta prompt.
export const ZETA_TEMPLATE_OVERHEAD_TOKENS = 128;

// Минимальный бюджет не даёт ошибочному profile/contextSize превратить каждый запрос в гарантированный overflow.
const ZETA_MIN_BUDGET_TOKENS = 256;

// Вход триммера содержит уже собранный контекст перед сборкой канонического SPM prompt.
export interface TrimZetaContextInput {
    profile: ZetaModelProfile;
    contextSize: number;
    prefixText: string;
    windowText: string;
    suffixText: string;
    cursorOffset: number;
    regions: ZetaEditableRegion[];
    recentEdits: RecentEdit[];
    relatedFiles: ZetaRelatedFile[];
    tokenCounter?: TokenCounter;
}

// Результат тримминга содержит только то что реально уместилось в budget и готово к prompt builder.
export interface TrimmedZetaContext {
    prefixBeforeRegion: string;
    windowText: string;
    suffixText: string;
    windowOffset: number;
    cursorOffset: number;
    regions: ZetaEditableRegion[];
    recentEdits: RecentEdit[];
    relatedFiles: ZetaRelatedFile[];
    overflow: boolean;
    consumedTokens: number;
}

/** Обрезает весь zeta21-контекст в приоритетном порядке SPM-зон, сохраняя стабильные offsets регионов и позиции курсора. */
export function trimZetaContext(input: TrimZetaContextInput, maxTokens: number): TrimmedZetaContext {
    const counter = input.tokenCounter;
    const budget = zetaTokenBudget(input.profile, input.contextSize, maxTokens);
    const windowBudget = Math.floor(budget * 0.4);
    const clampedWindow = clampWindowAroundCursor(input.windowText, input.cursorOffset, input.regions, windowBudget, counter);
    let remaining = budget - tokenCost(clampedWindow.text, counter);
    const overflow = clampedWindow.text.trim().length === 0 || clampedWindow.regions.length === 0 || remaining < 0;

    let prefixBeforeRegion = '';
    if (!overflow) {
        const prefixBudget = Math.max(0, Math.floor(remaining * 0.6));
        prefixBeforeRegion = trimTailToTokenBudget(normalizeCrlf(input.prefixText), prefixBudget, counter);
        remaining -= tokenCost(prefixBeforeRegion, counter);
    }

    let suffixText = '';
    if (!overflow && remaining > 0) {
        const suffixBudget = Math.max(0, Math.floor(remaining * 0.5));
        suffixText = trimHeadToTokenBudget(normalizeCrlf(input.suffixText), suffixBudget, counter);
        remaining -= tokenCost(suffixText, counter);
    }

    const recentEdits = trimRecentEdits(input.recentEdits, remaining, counter);
    remaining -= tokenCostForRecentEdits(recentEdits, counter);
    const relatedFiles = trimRelatedFiles(input.relatedFiles, remaining, counter);
    remaining -= tokenCostForRelatedFiles(relatedFiles, counter);

    LOG.info('Zeta context trimmed', {
        contextProfile: input.profile.id,
        contextTokens: input.profile.contextTokens,
        maxTokens,
        budget,
        remaining,
        overflow,
        prefixTokens: tokenCost(prefixBeforeRegion, counter),
        windowTokens: tokenCost(clampedWindow.text, counter),
        suffixTokens: tokenCost(suffixText, counter),
        regions: clampedWindow.regions.length,
        recentEditsIn: input.recentEdits.length,
        recentEditsOut: recentEdits.length,
        relatedIn: input.relatedFiles.length,
        relatedOut: relatedFiles.length,
    });

    return {
        prefixBeforeRegion,
        windowText: clampedWindow.text,
        suffixText,
        windowOffset: clampedWindow.startOffset,
        cursorOffset: clampedWindow.cursorOffset,
        regions: clampedWindow.regions,
        recentEdits,
        relatedFiles,
        overflow,
        consumedTokens: budget - remaining,
    };
}

function zetaTokenBudget(profile: ZetaModelProfile, contextSize: number, maxTokens: number): number {
    const reserved = maxTokens + ZETA_TEMPLATE_OVERHEAD_TOKENS;
    const effectiveContext = contextSize > 0 ? Math.min(contextSize, profile.contextTokens) : profile.contextTokens;
    return Math.max(ZETA_MIN_BUDGET_TOKENS, effectiveContext - reserved);
}

function clampWindowAroundCursor(text: string, cursorOffset: number, regions: ZetaEditableRegion[], maxTokens: number, counter?: TokenCounter): { text: string; startOffset: number; cursorOffset: number; regions: ZetaEditableRegion[] } {
    const normalized = normalizeCrlf(text);
    const safeCursor = Math.max(0, Math.min(cursorOffset, normalized.length));
    if (tokenCost(normalized, counter) <= maxTokens) {
        return { text: normalized, startOffset: 0, cursorOffset: safeCursor, regions };
    }
    let maxChars = Math.min(normalized.length, Math.max(1, maxTokens * 4));
    while (maxChars > 0) {
        const half = Math.floor(maxChars / 2);
        let start = Math.max(0, safeCursor - half);
        const end = Math.min(normalized.length, start + maxChars);
        start = Math.max(0, end - maxChars);
        const candidate = normalized.slice(start, end);
        if (tokenCost(candidate, counter) <= maxTokens) {
            return {
                text: candidate,
                startOffset: start,
                cursorOffset: safeCursor - start,
                regions: clampRegions(regions, start, end),
            };
        }
        maxChars = Math.floor(maxChars * 0.8);
    }
    return { text: '', startOffset: 0, cursorOffset: 0, regions: [] };
}

function clampRegions(regions: ZetaEditableRegion[], sliceStart: number, sliceEnd: number): ZetaEditableRegion[] {
    const clamped: Array<{ startOffset: number; endOffset: number }> = [];
    for (let i = 0; i < regions.length; i++) {
        const region = regions[i];
        const startOffset = Math.max(0, region.startOffset - sliceStart);
        const endOffset = Math.min(sliceEnd - sliceStart, region.endOffset - sliceStart);
        if (endOffset > startOffset) {
            clamped.push({ startOffset, endOffset });
        }
    }
    const out = new Array<ZetaEditableRegion>(clamped.length);
    for (let i = 0; i < clamped.length; i++) {
        out[i] = { markerIndex: i * 2 + 1, startOffset: clamped[i].startOffset, endOffset: clamped[i].endOffset };
    }
    return out;
}

function trimRecentEdits(recentEdits: RecentEdit[], maxTokens: number, counter?: TokenCounter): RecentEdit[] {
    if (maxTokens <= 0 || recentEdits.length === 0) {
        return [];
    }
    const newestFirst = recentEdits.slice().sort((a, b) => b.timestamp - a.timestamp);
    const kept: RecentEdit[] = [];
    let remaining = maxTokens;
    for (let i = 0; i < newestFirst.length; i++) {
        const edit = newestFirst[i];
        const cost = tokenCost(normalizeCrlf(edit.unifiedDiff), counter) + tokenCost(edit.uri, counter) + 8;
        if (cost > remaining) {
            continue;
        }
        kept.push(edit);
        remaining -= cost;
    }
    kept.sort((a, b) => a.timestamp - b.timestamp);
    return kept;
}

function trimRelatedFiles(relatedFiles: ZetaRelatedFile[], maxTokens: number, counter?: TokenCounter): ZetaRelatedFile[] {
    if (maxTokens <= 0 || relatedFiles.length === 0) {
        return [];
    }
    const ordered = relatedFiles.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const kept: ZetaRelatedFile[] = [];
    let remaining = maxTokens;
    for (let i = 0; i < ordered.length; i++) {
        const related = ordered[i];
        const cost = tokenCost(related.content, counter) + tokenCost(related.filePath, counter) + 8;
        if (cost > remaining) {
            continue;
        }
        kept.push(related);
        remaining -= cost;
    }
    return kept;
}

function tokenCostForRecentEdits(recentEdits: RecentEdit[], counter?: TokenCounter): number {
    let total = 0;
    for (let i = 0; i < recentEdits.length; i++) {
        total += tokenCost(normalizeCrlf(recentEdits[i].unifiedDiff), counter) + tokenCost(recentEdits[i].uri, counter) + 8;
    }
    return total;
}

function tokenCostForRelatedFiles(relatedFiles: ZetaRelatedFile[], counter?: TokenCounter): number {
    let total = 0;
    for (let i = 0; i < relatedFiles.length; i++) {
        total += tokenCost(relatedFiles[i].content, counter) + tokenCost(relatedFiles[i].filePath, counter) + 8;
    }
    return total;
}

function tokenCost(text: string, counter?: TokenCounter): number {
    return counter ? counter.count(text) : charTokenEstimate(text);
}

function trimTailToTokenBudget(text: string, maxTokens: number, counter?: TokenCounter): string {
    if (maxTokens <= 0 || !text) {
        return '';
    }
    if (tokenCost(text, counter) <= maxTokens) {
        return text;
    }
    let maxChars = Math.min(text.length, Math.max(1, maxTokens * 4));
    while (maxChars > 0) {
        const candidate = text.slice(text.length - maxChars);
        if (tokenCost(candidate, counter) <= maxTokens) {
            return candidate;
        }
        maxChars = Math.floor(maxChars * 0.8);
    }
    return '';
}

function trimHeadToTokenBudget(text: string, maxTokens: number, counter?: TokenCounter): string {
    if (maxTokens <= 0 || !text) {
        return '';
    }
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
