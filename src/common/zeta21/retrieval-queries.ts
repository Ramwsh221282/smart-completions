import type { DiagnosticDTO } from '../editor-dto';
import type { RecentEdit } from '../edit-history-types';
import { ZetaLogger } from './logger';
import {
    declaredTypeNames,
    diagnosticSymbols,
    importedSymbols,
    recentEditDiffTail,
    renamedSymbols,
    symbolAtCursor,
    testNames,
} from './signals';

// Логгер retrieval query builder нужен чтобы видеть какие edit-сигналы реально попали в zeta21 query.
const LOG = new ZetaLogger('common:retrieval-queries');

// Входные данные для retrieval query объединяют все edit-сигналы в одном месте, чтобы разные каналы получали одинаковый запрос.
export interface ZetaRetrievalSignalInput {
    recentEdits: RecentEdit[];
    windowText: string;
    cursorOffset: number;
    diagnostics?: DiagnosticDTO[];
    maxChars: number;
}

/** Строит zeta21 retrieval query из edit-сигналов и хвоста unified-diff, а не из слепого текстового окна. */
export function buildZetaRetrievalQuery(input: ZetaRetrievalSignalInput): string {
    const signals: string[] = [];
    const seen = new Set<string>();
    const push = (value: string | undefined): void => {
        const trimmed = value?.trim();
        if (trimmed && !seen.has(trimmed)) {
            seen.add(trimmed);
            signals.push(trimmed);
        }
    };
    const pushAll = (values: string[]): void => {
        for (let i = 0; i < values.length; i++) {
            push(values[i]);
        }
    };

    push(symbolAtCursor(input.windowText, input.cursorOffset));
    pushAll(renamedSymbols(input.recentEdits));
    pushAll(diagnosticSymbols(input.diagnostics));
    pushAll(importedSymbols(input.windowText));
    pushAll(declaredTypeNames(input.windowText));
    pushAll(testNames(input.windowText));

    const diffTail = recentEditDiffTail(input.recentEdits, input.maxChars);
    const head = signals.join(' ');
    const combined = head && diffTail ? `${head}\n${diffTail}` : head || diffTail;
    const query = combined.length > input.maxChars ? combined.slice(0, input.maxChars) : combined;
    LOG.info('Zeta retrieval query built', {
        signalCount: signals.length,
        diffChars: diffTail.length,
        queryChars: query.length,
        maxChars: input.maxChars,
    });
    if (process.env.NODE_ENV === 'development') {
        LOG.debug('Zeta retrieval query text', { query });
    }
    return query;
}

/** Строит дедуплицированный список точечных запросов для related-source поиска по workspace и LSP. */
export function buildZetaRelatedFileQueries(input: ZetaRetrievalSignalInput): string[] {
    const queries: string[] = [];
    const seen = new Set<string>();
    const add = (value: string | undefined): void => {
        const trimmed = value?.trim();
        if (trimmed && !seen.has(trimmed)) {
            seen.add(trimmed);
            queries.push(trimmed);
        }
    };
    const addAll = (values: string[]): void => {
        for (let i = 0; i < values.length; i++) {
            add(values[i]);
        }
    };
    add(symbolAtCursor(input.windowText, input.cursorOffset));
    addAll(renamedSymbols(input.recentEdits));
    addAll(diagnosticSymbols(input.diagnostics));
    addAll(importedSymbols(input.windowText));
    addAll(declaredTypeNames(input.windowText));
    addAll(testNames(input.windowText));
    LOG.info('Zeta related-file queries built', { count: queries.length, queries });
    return queries;
}
