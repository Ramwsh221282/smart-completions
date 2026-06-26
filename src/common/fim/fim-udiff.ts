import { createTwoFilesPatch } from 'diff';
import type { RecentEdit } from '../edit-history-types';

export function buildEditHistorySnippets(fileToken: string, recentEdits: RecentEdit[], maxEdits: number): string[] {
    if (maxEdits <= 0 || recentEdits.length === 0) {
        return [];
    }
    const ordered = recentEdits.slice().sort((a, b) => a.timestamp - b.timestamp);
    const count = ordered.length > maxEdits ? maxEdits : ordered.length;
    const out = new Array<string>(count);
    const start = ordered.length - count;
    for (let i = 0; i < count; i++) {
        out[i] = toEditSnippet(fileToken, ordered[start + i]);
    }
    return out;
}

function toEditSnippet(fileToken: string, edit: RecentEdit): string {
    return `${fileToken}${edit.uri}\n${buildUnifiedDiff(edit)}`;
}

function buildUnifiedDiff(edit: RecentEdit): string {
    if (typeof edit.before === 'string' && typeof edit.after === 'string') {
        return createTwoFilesPatch(`a/${edit.uri}`, `b/${edit.uri}`, edit.before, edit.after, '', '', { context: 2 }).trimEnd();
    }
    return edit.unifiedDiff.trimEnd();
}
