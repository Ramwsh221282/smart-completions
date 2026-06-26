import * as monaco from '@theia/monaco-editor-core';
import type { DiagnosticDTO } from '../../../common/editor-dto';
import type { RecentEdit } from '../../../common/edit-history-types';
import { fileModeForLanguage } from '../../shared/file-mode';
import { buildRegions } from '../../../common/zeta21/markers';
import type { ZetaEditableRegion, ZetaRequest } from '../../../common/zeta21/types';
import { ZetaLogger } from '../../../common/zeta21/logger';
import type { CollectedZetaContext } from '../data-gathering-layer/zeta-context-collector';
import { ZetaEditHistoryRecorder } from '../data-gathering-layer/zeta-edit-history-recorder';

// Логгер строителя запросов нужен для диагностики того, что именно попало в финальный RPC-запрос zeta21.
const LOG = new ZetaLogger('browser:data-formatting:request-builder');

// Промежуточный снимок состояния редактора создаётся до сбора контекста, чтобы зафиксировать один детерминированный момент trigger. 
export interface ZetaEditorSnapshot {
    prefixText: string;
    windowText: string;
    suffixText: string;
    windowStart: { line: number; character: number };
    cursorOffset: number;
    regions: ZetaEditableRegion[];
    recentEdits: RecentEdit[];
    diagnostics: DiagnosticDTO[];
}

/** Строит снимок редактора до сбора контекста и финальный RPC-запрос после, разделяя две фазы zeta21 trigger-потока. */
export class ZetaRequestBuilder {
    /** Фиксирует состояние редактора в момент trigger и останавливает цикл если обязательная история правок пока пуста. */
    snapshot(model: monaco.editor.ITextModel, position: monaco.Position, history: ZetaEditHistoryRecorder): ZetaEditorSnapshot | undefined {
        const uri = model.uri.toString();
        const recentEdits = history.getRecentEdits(uri, 8);
        if (recentEdits.length === 0) {
            LOG.info('Zeta snapshot skipped because recent edit history is empty', { uri });
            return undefined;
        }
        const fileMode = fileModeForLanguage(model.getLanguageId());
        const region = fileMode === 'prose' ? editorParagraph(model, position) : editorLine(model, position);
        const fullText = model.getValue();
        const prefixText = fullText.slice(0, region.startOffset);
        const suffixText = fullText.slice(region.endOffset);
        const regions = buildRegions({ windowText: region.text, cursorOffset: region.cursorOffset, syntacticBounds: null });
        const diagnostics = collectDiagnostics(model);
        LOG.info('Zeta editor snapshot captured', {
            uri,
            fileMode,
            prefixChars: prefixText.length,
            windowChars: region.text.length,
            suffixChars: suffixText.length,
            regions: regions.length,
            recentEdits: recentEdits.length,
            diagnostics: diagnostics.length,
        });
        return {
            prefixText,
            windowText: region.text,
            suffixText,
            windowStart: region.start,
            cursorOffset: region.cursorOffset,
            regions,
            recentEdits,
            diagnostics,
        };
    }

    /** Собирает снимок и collected related-контекст в единый ZetaRequest для отправки на отдельный zeta21 backend path. */
    request(model: monaco.editor.ITextModel, snapshot: ZetaEditorSnapshot, collected: CollectedZetaContext): ZetaRequest {
        const languageId = model.getLanguageId();
        const request = {
            requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            uri: model.uri.toString(),
            languageId,
            fileMode: fileModeForLanguage(languageId),
            prefixText: snapshot.prefixText,
            windowText: snapshot.windowText,
            suffixText: snapshot.suffixText,
            windowStart: snapshot.windowStart,
            cursorOffset: snapshot.cursorOffset,
            regions: snapshot.regions,
            recentEdits: snapshot.recentEdits,
            relatedFiles: collected.relatedFiles,
            diagnostics: snapshot.diagnostics,
        };
        LOG.info('Zeta backend request built', {
            requestId: request.requestId,
            uri: request.uri,
            fileMode: request.fileMode,
            regions: request.regions.length,
            recentEdits: request.recentEdits.length,
            relatedFiles: request.relatedFiles.length,
        });
        return request;
    }
}

function editorLine(model: monaco.editor.ITextModel, position: monaco.Position): { text: string; start: { line: number; character: number }; cursorOffset: number; startOffset: number; endOffset: number } {
    const startLineNumber = position.lineNumber;
    const endLineNumber = position.lineNumber;
    const start = { lineNumber: startLineNumber, column: 1 };
    const end = { lineNumber: endLineNumber, column: model.getLineMaxColumn(endLineNumber) };
    const text = model.getValueInRange({ startLineNumber, startColumn: 1, endLineNumber, endColumn: end.column });
    const startOffset = model.getOffsetAt(start);
    const endOffset = model.getOffsetAt(end);
    return {
        text,
        start: { line: startLineNumber - 1, character: 0 },
        cursorOffset: model.getOffsetAt(position) - startOffset,
        startOffset,
        endOffset,
    };
}

function editorParagraph(model: monaco.editor.ITextModel, position: monaco.Position): { text: string; start: { line: number; character: number }; cursorOffset: number; startOffset: number; endOffset: number } {
    let startLineNumber = position.lineNumber;
    let endLineNumber = position.lineNumber;
    while (startLineNumber > 1 && !isBlankLine(model, startLineNumber - 1)) {
        startLineNumber--;
    }
    while (endLineNumber < model.getLineCount() && !isBlankLine(model, endLineNumber + 1)) {
        endLineNumber++;
    }
    const start = { lineNumber: startLineNumber, column: 1 };
    const end = { lineNumber: endLineNumber, column: model.getLineMaxColumn(endLineNumber) };
    const text = model.getValueInRange({ startLineNumber, startColumn: 1, endLineNumber, endColumn: end.column });
    const startOffset = model.getOffsetAt(start);
    const endOffset = model.getOffsetAt(end);
    return {
        text,
        start: { line: startLineNumber - 1, character: 0 },
        cursorOffset: model.getOffsetAt(position) - startOffset,
        startOffset,
        endOffset,
    };
}

function isBlankLine(model: monaco.editor.ITextModel, lineNumber: number): boolean {
    return model.getLineContent(lineNumber).trim().length === 0;
}

function collectDiagnostics(model: monaco.editor.ITextModel): DiagnosticDTO[] {
    const markers = monaco.editor.getModelMarkers({ resource: model.uri, take: 20 });
    const diagnostics = new Array<DiagnosticDTO>(markers.length);
    for (let i = 0; i < markers.length; i++) {
        const marker = markers[i];
        diagnostics[i] = {
            range: {
                start: { line: marker.startLineNumber - 1, character: marker.startColumn - 1 },
                end: { line: marker.endLineNumber - 1, character: marker.endColumn - 1 },
            },
            severity: marker.severity === monaco.MarkerSeverity.Error
                ? 'error' as const
                : marker.severity === monaco.MarkerSeverity.Warning
                    ? 'warning' as const
                    : marker.severity === monaco.MarkerSeverity.Info
                        ? 'info' as const
                        : 'hint' as const,
            message: marker.message,
            code: marker.code ? String(marker.code) : undefined,
        };
    }
    if (process.env.NODE_ENV === 'development') {
        LOG.debug('Zeta diagnostics collected from Monaco', { uri: model.uri.toString(), diagnostics: diagnostics.length });
    }
    return diagnostics;
}
