import type { RecentEdit } from '../edit-history-types';
import { FimLogger } from './logger';
import { declaredTypeNames, importedSymbols, recentEditDiffTail, renamedSymbols, symbolAtCursor, testNames as collectTestNames } from '../sweep/signals';
import type { GraphQuerySignals } from '../sweep/types';

const LOG = new FimLogger('common:retrieval-queries');

export interface FimRetrievalSignalInput {
    prefix: string;
    recentEdits: RecentEdit[];
    prefixTailChars: number;
}

export interface FimSignals {
    graph: GraphQuerySignals;
    fuzzySymbols: string[];
}

export function buildFimRetrievalQuery(input: FimRetrievalSignalInput): string {
    const prefixTailChars = Math.max(0, input.prefixTailChars);
    const prefix = input.prefix.slice(-prefixTailChars);
    const signals = signalTerms(prefix, input.recentEdits);
    const diffTail = recentEditDiffTail(input.recentEdits, prefixTailChars);
    const head = signals.join(' ');
    const combined = head && diffTail ? `${head}\n${diffTail}` : head || diffTail;
    const query = combined.length > prefixTailChars ? combined.slice(0, prefixTailChars) : combined;
    LOG.info('FIM retrieval query built', { signalCount: signals.length, diffChars: diffTail.length, queryChars: query.length, maxChars: prefixTailChars });
    return query;
}

export function extractFimSignals(prefix: string, recentEdits: RecentEdit[]): FimSignals {
    const tail = prefix;
    const cursorSymbol = symbolAtCursor(tail, tail.length);
    const renamed = renamedSymbols(recentEdits);
    const imported = importedSymbols(tail);
    const declared = declaredTypeNames(tail);
    const tests = collectTestNames(tail);
    return {
        graph: {
            cursorSymbol,
            renamedSymbols: renamed,
            diagnosticSymbols: [],
            importedSymbols: imported,
        },
        fuzzySymbols: stableUnique([cursorSymbol, ...renamed, ...imported, ...declared, ...tests]),
    };
}

function signalTerms(prefix: string, recentEdits: RecentEdit[]): string[] {
    const signals = extractFimSignals(prefix, recentEdits);
    return stableUnique([
        signals.graph.cursorSymbol,
        ...signals.graph.renamedSymbols,
        ...signals.graph.importedSymbols,
        ...signals.fuzzySymbols,
    ]);
}

function stableUnique(values: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < values.length; i++) {
        const value = values[i]?.trim();
        if (value && !seen.has(value)) {
            seen.add(value);
            out.push(value);
        }
    }
    return out;
}
