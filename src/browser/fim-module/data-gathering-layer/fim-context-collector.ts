import URI from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import type { CoreDiagnostic, CoreOutlineItem, CoreRelatedFileHint, CoreSignals } from '../../../common/core/core-protocol';
import type { DiagnosticDTO } from '../../../common/editor-dto';
import type { FimRelatedFile } from '../../../common/fim-types';
import type { RecentEdit } from '../../../common/edit-history-types';
import type { OutlineSymbol } from '../../../common/sweep/outline';
import {
    declaredTypeNames,
    diagnosticSymbols,
    importedSymbols,
    renamedSymbols,
    symbolAtCursor,
    testNames,
} from '../../../common/sweep/signals';
import { dedupeRankRelated } from '../../../common/zeta21/related-files';
import { FimLogger } from '../../../common/fim/logger';
import { fileModeForLanguage } from '../../shared/file-mode';
import { SymbolSource } from '../../sweep/data-gathering-layer/sources/symbol-source';
import { FimEditHistoryRecorder } from './fim-edit-history-recorder';
import { FimDefinitionRelatedSource } from './sources/definition-source';
import { FimWorkspaceFiles } from './sources/workspace-files';

const LOG = new FimLogger('browser:data-gathering:context-collector');
const MAX_FIM_RELATED_FILES = 6;
const MAX_DIAGNOSTICS = 20;
const SIGNAL_WINDOW_RADIUS = 40;

export interface CollectFimContextParams {
    model: monaco.editor.ITextModel;
    position: monaco.Position;
    collectRecentEdits: boolean;
    collectRelatedFiles: boolean;
    collectDiagnostics: boolean;
    collectCoreEnvelope: boolean;
}

export interface CollectedFimContext {
    recentEdits: RecentEdit[];
    relatedFiles: FimRelatedFile[];
    diagnostics: CoreDiagnostic[];
    outline: CoreOutlineItem[];
    relatedFileHints: CoreRelatedFileHint[];
    signals?: CoreSignals;
}

@injectable()
export class FimContextCollector {
    @inject(FimDefinitionRelatedSource) protected readonly definitions!: FimDefinitionRelatedSource;
    @inject(FimEditHistoryRecorder) protected readonly history!: FimEditHistoryRecorder;
    @inject(FimWorkspaceFiles) protected readonly files!: FimWorkspaceFiles;
    @inject(SymbolSource) protected readonly symbols!: SymbolSource;

    async collect(params: CollectFimContextParams): Promise<CollectedFimContext> {
        const uri = new URI(params.model.uri.toString());
        const currentRel = this.safe(() => this.files.relativePath(uri), uri.path.base, 'relative-path');
        const sourceCtx = {
            uri,
            position: { line: params.position.lineNumber - 1, character: params.position.column - 1 },
            currentRelPath: currentRel,
        };
        const [relatedCandidates, recentEdits, outlineSymbols] = await Promise.all([
            params.collectRelatedFiles ? this.definitions.collect(sourceCtx) : Promise.resolve([]),
            Promise.resolve(params.collectRecentEdits ? this.history.getRecentEdits(params.model.uri.toString(), 8) : []),
            this.collectOutline(params),
        ]);
        const relatedFiles: FimRelatedFile[] = dedupeRankRelated(relatedCandidates, MAX_FIM_RELATED_FILES);
        const diagnostics = params.collectDiagnostics ? collectDiagnostics(params.model) : [];
        const relatedFileHints = params.collectCoreEnvelope ? buildRelatedFileHints(relatedFiles) : [];
        const outline = params.collectCoreEnvelope ? flattenOutline(outlineSymbols) : [];
        const signals = params.collectCoreEnvelope
            ? coreSignals(params.model, params.position, recentEdits, diagnostics)
            : undefined;
        LOG.info('FIM context collected', {
            relatedFiles: relatedFiles.length,
            recentEdits: recentEdits.length,
            diagnostics: diagnostics.length,
            outline: outline.length,
            currentRel,
        });
        return { relatedFiles, recentEdits, diagnostics, outline, relatedFileHints, signals };
    }

    private safe<T>(fn: () => T, fallback: T, label: string): T {
        try {
            return fn();
        } catch (error) {
            LOG.warn('FIM context source failed', { label, error: error instanceof Error ? error.message : String(error) });
            return fallback;
        }
    }

    private collectOutline(params: CollectFimContextParams): Promise<OutlineSymbol[]> {
        if (!params.collectCoreEnvelope || fileModeForLanguage(params.model.getLanguageId()) !== 'code') {
            return Promise.resolve([]);
        }
        return this.safeAsync(() => this.symbols.symbols(params.model), [], 'outline');
    }

    private async safeAsync<T>(fn: () => Promise<T>, fallback: T, label: string): Promise<T> {
        try {
            return await fn();
        } catch (error) {
            LOG.warn('FIM async context source failed', { label, error: error instanceof Error ? error.message : String(error) });
            return fallback;
        }
    }
}

function collectDiagnostics(model: monaco.editor.ITextModel): CoreDiagnostic[] {
    const markers = monaco.editor.getModelMarkers({ resource: model.uri, take: MAX_DIAGNOSTICS });
    const diagnostics = new Array<CoreDiagnostic>(markers.length);
    for (let i = 0; i < markers.length; i++) {
        const marker = markers[i];
        diagnostics[i] = {
            range: {
                start: { line: marker.startLineNumber - 1, character: marker.startColumn - 1 },
                end: { line: marker.endLineNumber - 1, character: marker.endColumn - 1 },
            },
            severity: marker.severity === monaco.MarkerSeverity.Error
                ? 'error'
                : marker.severity === monaco.MarkerSeverity.Warning
                    ? 'warning'
                    : marker.severity === monaco.MarkerSeverity.Info
                        ? 'info'
                        : 'hint',
            message: marker.message,
            code: marker.code ? String(marker.code) : undefined,
        };
    }
    return diagnostics;
}

function buildRelatedFileHints(relatedFiles: FimRelatedFile[]): CoreRelatedFileHint[] {
    const hints = new Array<CoreRelatedFileHint>(relatedFiles.length);
    for (let i = 0; i < relatedFiles.length; i++) {
        hints[i] = {
            path: relatedFiles[i].filePath,
            source: 'definition',
            scoreHint: relatedFiles[i].score,
        };
    }
    return hints;
}

function flattenOutline(symbols: OutlineSymbol[]): CoreOutlineItem[] {
    const items: CoreOutlineItem[] = [];
    appendOutline(symbols, items);
    return items;
}

function appendOutline(symbols: OutlineSymbol[], items: CoreOutlineItem[]): void {
    for (let i = 0; i < symbols.length; i++) {
        items.push(toCoreOutlineItem(symbols[i]));
        const children = symbols[i].children;
        if (children && children.length > 0) {
            appendOutline(children, items);
        }
    }
}

function toCoreOutlineItem(symbol: OutlineSymbol): CoreOutlineItem {
    const startCharacter = symbol.startChar ?? 0;
    const endCharacter = symbol.endChar ?? startCharacter;
    return {
        name: symbol.name,
        kind: symbol.kind,
        range: {
            start: { line: symbol.startLine, character: startCharacter },
            end: { line: symbol.endLine, character: endCharacter },
        },
    };
}

function coreSignals(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    recentEdits: RecentEdit[],
    diagnostics: DiagnosticDTO[],
): CoreSignals {
    const window = signalWindow(model, position);
    return {
        symbolAtCursor: symbolAtCursor(window.text, window.cursorOffset) || undefined,
        renamedSymbols: renamedSymbols(recentEdits),
        importedSymbols: importedSymbols(window.text),
        declaredTypes: declaredTypeNames(window.text),
        testNames: testNames(window.text),
        diagnosticSymbols: diagnosticSymbols(diagnostics),
        fuzzySymbols: [],
        retrievalSignalHints: [],
    };
}

function signalWindow(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
): { text: string; cursorOffset: number } {
    const startLineNumber = Math.max(1, position.lineNumber - SIGNAL_WINDOW_RADIUS);
    const endLineNumber = Math.min(model.getLineCount(), position.lineNumber + SIGNAL_WINDOW_RADIUS);
    const start = new monaco.Position(startLineNumber, 1);
    return {
        text: model.getValueInRange({
            startLineNumber,
            startColumn: 1,
            endLineNumber,
            endColumn: model.getLineMaxColumn(endLineNumber),
        }),
        cursorOffset: model.getOffsetAt(position) - model.getOffsetAt(start),
    };
}
