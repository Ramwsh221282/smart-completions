import { injectable } from '@theia/core/shared/inversify';
import type { Neighbor } from '../../../../common/embedding-types';
import type { GraphQuerySignals } from '../../../../common/sweep/types';
import { SweepGraphIndexer } from './sweep-graph-indexer';
import type { SymbolRow } from './sweep-graph-store';

/** Лимит declarations на имя удерживает graph channel быстрым и не даёт одному символу занять весь pool. */
const GRAPH_DECL_LIMIT = 8;

/** Лимит references на имя ограничивает caller expansion в больших репозиториях. */
const GRAPH_REF_LIMIT = 12;

/** Лимит parent symbols для одной reference строки выбирает ближайшую enclosing декларацию. */
const GRAPH_PARENT_LIMIT = 1;

/** Структурный Sweep channel ищет declarations и caller contexts по edit-signal symbol names. */
@injectable()
export class SweepGraphChannel {
    private readonly indexer: SweepGraphIndexer;

    /** Indexer владеет SQLite store и live dirty-aware обновлениями. */
    constructor(indexer: SweepGraphIndexer) {
        this.indexer = indexer;
    }

    /** Возвращает graph neighbors по exact symbol matches, готовые к общему RRF merge. */
    retrieve(signals: GraphQuerySignals, topN: number): Neighbor[] {
        const store = this.indexer.getStore();
        if (!store || topN <= 0) {
            return [];
        }
        const names = graphSignalNames(signals);
        const acc = new Map<string, Neighbor>();
        for (let i = 0; i < names.length; i++) {
            const name = names[i];
            const declarations = store.declarationsByName(name, GRAPH_DECL_LIMIT);
            for (let j = 0; j < declarations.length; j++) {
                addSymbolNeighbor(acc, declarations[j], graphSymbolScore(declarations[j], 1));
            }
            const refs = store.referencesToName(name, GRAPH_REF_LIMIT);
            for (let j = 0; j < refs.length; j++) {
                const parents = store.symbolsContainingLine(refs[j].file, refs[j].line, GRAPH_PARENT_LIMIT);
                if (parents.length > 0) {
                    addSymbolNeighbor(acc, parents[0], graphSymbolScore(parents[0], 0.8));
                } else {
                    addFallbackReference(acc, refs[j].file, refs[j].line, name);
                }
            }
        }
        return sortedNeighbors(acc, topN);
    }
}

/** Собирает ordered unique symbol names из edit-сигналов для exact graph lookup. */
function graphSignalNames(signals: GraphQuerySignals): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    addName(out, seen, signals.cursorSymbol);
    addNames(out, seen, signals.renamedSymbols);
    addNames(out, seen, signals.diagnosticSymbols);
    addNames(out, seen, signals.importedSymbols);
    return out;
}

/** Добавляет список имён в stable unique buffer. */
function addNames(out: string[], seen: Set<string>, names: string[]): void {
    for (let i = 0; i < names.length; i++) {
        addName(out, seen, names[i]);
    }
}

/** Добавляет одно имя в stable unique buffer после trim-фильтрации. */
function addName(out: string[], seen: Set<string>, value: string | undefined): void {
    const name = value?.trim();
    if (name && !seen.has(name)) {
        seen.add(name);
        out.push(name);
    }
}

/** Добавляет symbol neighbor с суммированием score при повторном попадании из declarations/refs. */
function addSymbolNeighbor(acc: Map<string, Neighbor>, symbol: SymbolRow, score: number): void {
    const key = `${symbol.file}:${symbol.startLine}:${symbol.endLine}`;
    const existing = acc.get(key);
    if (existing) {
        existing.score += score;
        return;
    }
    acc.set(key, { filePath: symbol.file, startLine: symbol.startLine, endLine: symbol.endLine, text: symbol.body, score });
}

/** Добавляет fallback context для reference без найденной enclosing declaration. */
function addFallbackReference(acc: Map<string, Neighbor>, file: string, line: number, name: string): void {
    const key = `${file}:${line}:${line}`;
    const existing = acc.get(key);
    if (existing) {
        existing.score += 0.2;
        return;
    }
    acc.set(key, { filePath: file, startLine: line, endLine: line, text: `reference ${name} at line ${line}`, score: 0.2 });
}

/** Возвращает базовый graph score с лёгким приоритетом функций/типов над variables. */
function graphSymbolScore(symbol: SymbolRow, base: number): number {
    if (symbol.kind === 'function' || symbol.kind === 'class' || symbol.kind === 'type') {
        return base + 0.15;
    }
    return base;
}

/** Сортирует accumulated graph neighbors по score и режет до pool size. */
function sortedNeighbors(acc: Map<string, Neighbor>, topN: number): Neighbor[] {
    const out = Array.from(acc.values());
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, topN);
}
