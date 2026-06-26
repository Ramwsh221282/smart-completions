import { RecentEdit } from '../edit-history-types';
import { DiagnosticDTO } from '../editor-dto';
import { SweepLogger } from './logger';
import {
    declaredTypeNames,
    diagnosticSymbols,
    importedSymbols,
    recentEditDiffTail,
    renamedSymbols,
    symbolAtCursor,
    testNames,
} from './signals';

// Логгер модуля запросов; нужен для диагностики того, какие сигналы вошли в финальный retrieval-запрос.
const LOG = new SweepLogger('common:retrieval-queries');

// Входные данные для построения retrieval-запроса; объединяет все edit-сигналы в одном месте.
export interface SweepRetrievalSignalInput {
    recentEdits: RecentEdit[];
    windowText: string;
    cursorOffset: number;
    diagnostics?: DiagnosticDTO[];
    maxChars: number;
}

// Псевдоним для обратной совместимости; тип сигналов одинаков для Sweep и старого NES-пути.
export type NesRetrievalSignalInput = SweepRetrievalSignalInput;

/**
 * Строит упрощённый retrieval-запрос только из хвоста диффов для обратной совместимости
 * со старыми тестами и legacy NES-маршрутом до перехода на Sweep.
 */
export function nesRetrievalQuery(recentEdits: RecentEdit[], maxChars: number): string {
    return recentEditDiffTail(recentEdits, maxChars);
}

/**
 * Строит Sweep retrieval-запрос из edit-signal символов и хвоста диффов, а не из слепого среза окна;
 * такой запрос точнее находит файлы связанные с текущим переименованием или рефакторингом.
 */
export function buildSweepRetrievalQuery(input: SweepRetrievalSignalInput): string {
    const signals: string[] = [];
    const seen = new Set<string>();
    const push = (value: string | undefined): void => {
        const v = value?.trim();
        if (v && !seen.has(v)) {
            seen.add(v);
            signals.push(v);
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
    LOG.info('Sweep retrieval query built', {
        signalCount: signals.length,
        diffChars: diffTail.length,
        queryChars: query.length,
        maxChars: input.maxChars,
    });
    if (process.env.NODE_ENV === 'development') {
        LOG.debug('Sweep retrieval query text', { query });
    }
    return query;
}

/**
 * Сохраняет старое публичное имя buildNesRetrievalQuery для совместимости с кодом
 * написанным до выделения Sweep в отдельный модуль.
 */
export function buildNesRetrievalQuery(input: SweepRetrievalSignalInput): string {
    return buildSweepRetrievalQuery(input);
}

/**
 * Строит список дедуплицированных поисковых запросов для нахождения related-файлов
 * через search-in-workspace и LSP-hierarchy; каждый запрос — отдельный edit-signal символ.
 */
export function buildRelatedFileQueries(input: SweepRetrievalSignalInput): string[] {
    const queries: string[] = [];
    const seen = new Set<string>();
    const add = (value: string | undefined): void => {
        const v = value?.trim();
        if (v && !seen.has(v)) {
            seen.add(v);
            queries.push(v);
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
    LOG.info('Sweep related-file queries built', { count: queries.length, queries });
    return queries;
}
