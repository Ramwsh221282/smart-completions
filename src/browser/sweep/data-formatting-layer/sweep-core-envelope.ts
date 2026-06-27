import { CoreOutlineItem, CoreRelatedFileHint, CoreSignals } from '../../../common/core/core-protocol';
import { CoreRequestContextEnvelope } from '../../../common/core/core-request-mapping';
import { RangeDTO } from '../../../common/editor-dto';
import { declaredTypeNames, diagnosticSymbols, importedSymbols, renamedSymbols, symbolAtCursor, testNames } from '../../../common/sweep/signals';
import { OutlineSymbol } from '../../../common/sweep/outline';
import { buildRelatedFileQueries } from '../../../common/sweep/retrieval-queries';
import { SweepEditorSnapshot } from './sweep-request-builder';
import { CollectedSweepContext } from '../data-gathering-layer/sweep-context-collector';

/** Builds the raw core envelope from an already-captured sweep snapshot. */
export function buildSweepCoreContext(
    snapshot: SweepEditorSnapshot,
    collected: CollectedSweepContext,
    queryMaxChars: number,
): CoreRequestContextEnvelope {
    return {
        recentEdits: snapshot.recentEdits,
        originalWindowText: snapshot.originalWindowText,
        diagnostics: snapshot.diagnostics,
        outline: toCoreOutline(collected.outlineSymbols),
        relatedFileHints: toCoreRelatedFileHints(collected),
        signals: buildSweepCoreSignals(snapshot, queryMaxChars),
    };
}

function buildSweepCoreSignals(snapshot: SweepEditorSnapshot, queryMaxChars: number): CoreSignals | undefined {
    const signals: CoreSignals = {
        symbolAtCursor: symbolAtCursor(snapshot.windowText, snapshot.cursorOffset) || undefined,
        renamedSymbols: renamedSymbols(snapshot.recentEdits),
        importedSymbols: importedSymbols(snapshot.windowText),
        declaredTypes: declaredTypeNames(snapshot.windowText),
        testNames: testNames(snapshot.windowText),
        diagnosticSymbols: diagnosticSymbols(snapshot.diagnostics),
        fuzzySymbols: undefined,
        retrievalSignalHints: buildRelatedFileQueries({
            recentEdits: snapshot.recentEdits,
            windowText: snapshot.windowText,
            cursorOffset: snapshot.cursorOffset,
            diagnostics: snapshot.diagnostics,
            maxChars: queryMaxChars,
        }),
    };

    return hasUsefulSignals(signals) ? signals : undefined;
}

function hasUsefulSignals(signals: CoreSignals): boolean {
    return Boolean(
        signals.symbolAtCursor
        || signals.renamedSymbols?.length
        || signals.importedSymbols?.length
        || signals.declaredTypes?.length
        || signals.testNames?.length
        || signals.diagnosticSymbols?.length
        || signals.fuzzySymbols?.length
        || signals.retrievalSignalHints?.length,
    );
}

function toCoreOutline(symbols: OutlineSymbol[] | undefined): CoreOutlineItem[] {
    if (!symbols?.length) {
        return [];
    }

    const items: CoreOutlineItem[] = [];
    appendOutlineItems(items, symbols);
    return items;
}

function appendOutlineItems(target: CoreOutlineItem[], symbols: OutlineSymbol[]): void {
    for (let i = 0; i < symbols.length; i++) {
        const symbol = symbols[i];
        target.push({
            name: symbol.name,
            kind: symbol.kind,
            range: toCoreRange(symbol),
            selectionRange: toSelectionRange(symbol),
        });
        if (symbol.children?.length) {
            appendOutlineItems(target, symbol.children);
        }
    }
}

function toCoreRange(symbol: OutlineSymbol): RangeDTO {
    return {
        start: { line: symbol.startLine, character: symbol.startChar ?? 0 },
        end: { line: symbol.endLine, character: symbol.endChar ?? 0 },
    };
}

function toSelectionRange(symbol: OutlineSymbol): RangeDTO {
    const character = symbol.startChar ?? 0;
    return {
        start: { line: symbol.startLine, character },
        end: { line: symbol.startLine, character: symbol.endChar ?? character },
    };
}

function toCoreRelatedFileHints(collected: CollectedSweepContext): CoreRelatedFileHint[] {
    const hints = new Array<CoreRelatedFileHint>(collected.selectedRelatedCandidates.length);
    for (let i = 0; i < collected.selectedRelatedCandidates.length; i++) {
        const candidate = collected.selectedRelatedCandidates[i];
        hints[i] = {
            path: candidate.filePath,
            range: toHintRange(candidate.startLine, candidate.endLine),
            source: 'sweep-related',
            scoreHint: candidate.score,
        };
    }
    return hints;
}

function toHintRange(startLine: number | undefined, endLine: number | undefined): RangeDTO | undefined {
    if (startLine === undefined || endLine === undefined) {
        return undefined;
    }
    return {
        start: { line: startLine, character: 0 },
        end: { line: endLine, character: 0 },
    };
}
