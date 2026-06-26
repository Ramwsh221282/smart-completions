import { createTwoFilesPatch } from 'diff';
import type { RecentEdit } from '../edit-history-types';
import { normalizeCrlf } from '../text/crlf';

// Псевдо-имя секции истории правок фиксировано форматом Zeta 2.1 и всегда открывает unified-diff блоки.
const EDIT_HISTORY_HEADER = '<filename>edit_history';

/** Строит Zeta edit_history как хронологическую конкатенацию unified-diff патчей, чтобы модель видела недавнюю эволюцию кода. */
export function buildEditHistoryBlock(recentEdits: RecentEdit[]): string {
    if (recentEdits.length === 0) {
        return '';
    }
    const ordered = recentEdits.slice().sort((a, b) => a.timestamp - b.timestamp);
    const parts: string[] = [EDIT_HISTORY_HEADER];
    for (let i = 0; i < ordered.length; i++) {
        parts.push(toUnifiedDiff(ordered[i]));
    }
    return parts.join('\n');
}

function toUnifiedDiff(edit: RecentEdit): string {
    const withSnapshots = edit as RecentEdit & { before?: string; after?: string };
    if (typeof withSnapshots.before === 'string' && typeof withSnapshots.after === 'string') {
        return createTwoFilesPatch(`a/${edit.uri}`, `b/${edit.uri}`, withSnapshots.before, withSnapshots.after, '', '', { context: 3 }).trimEnd();
    }
    return normalizeCrlf(edit.unifiedDiff).trim();
}
