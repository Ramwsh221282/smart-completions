import * as monaco from '@theia/monaco-editor-core';
import { DiagnosticDTO } from '../../../common/editor-dto';
import { RecentEdit } from '../../../common/edit-history-types';
import { SweepLogger } from '../../../common/sweep/logger';
import { reconstructOriginalWindow } from '../../../common/sweep/original-window-reconstruction';
import type { SweepModelProfile } from '../../../common/sweep/profiles';
import { SweepRequest } from '../../../common/sweep/types';
import { fileModeForLanguage } from '../../shared/file-mode';
import { CollectedSweepContext } from '../data-gathering-layer/sweep-context-collector';
import { SweepEditHistoryRecorder } from '../data-gathering-layer/sweep-edit-history-recorder';

// Логгер строителя запросов; нужен для диагностики того, что именно попало в финальный RPC-запрос к бекенду.
const LOG = new SweepLogger('browser:data-formatting:request-builder');

// Промежуточный снимок состояния редактора; создаётся до сбора контекста, чтобы зафиксировать момент триггера.
export interface SweepEditorSnapshot {
    windowText: string;
    windowStart: { line: number; character: number };
    windowLineCount: number;
    broadFileText: string;
    broadFileStartLine: number;
    originalWindowText?: string;
    cursorOffset: number;
    recentEdits: RecentEdit[];
    diagnostics: DiagnosticDTO[];
}

/** Строит снимок редактора до сбора контекста и финальный RPC-запрос после, разделяя две фазы триггерного цикла. */
export class SweepRequestBuilder {
    /**
     * Фиксирует состояние редактора в момент триггера: окно, диагностики и обязательную историю правок;
     * возвращает undefined если история пуста, останавливая цикл до запуска сборщика контекста.
     */
    snapshot(model: monaco.editor.ITextModel, position: monaco.Position, history: SweepEditHistoryRecorder, profile: SweepModelProfile): SweepEditorSnapshot | undefined {
        const uri = model.uri.toString();
        const fileMode = fileModeForLanguage(model.getLanguageId());
        const recentEdits = history.getRecentEdits(uri, 8);
        if (recentEdits.length === 0) {
            LOG.info('Sweep snapshot skipped because recent edit history is empty', { uri });
            return undefined;
        }
        const window = fileMode === 'prose'
            ? editorProseWindow(model, position, profile.windowBefore, profile.windowAfter)
            : editorWindow(model, position, profile.windowBefore, profile.windowAfter);
        const broad = editorBroadWindow(model, position, profile.broadFileLines);
        const storedOriginalWindowText = history.getWindowBeforeLastEdit(
            uri,
            window.start.line,
            window.start.line + window.lineCount - 1,
        );
        const reconstructedOriginalWindowText = storedOriginalWindowText ?? reconstructOriginalWindow(window.text, window.start.line, uri, recentEdits);
        const diagnostics = collectDiagnostics(model);
        LOG.info('Sweep editor snapshot captured', {
            uri,
            fileMode,
            windowChars: window.text.length,
            windowStartLine: window.start.line,
            broadFileChars: broad.text.length,
            broadFileStartLine: broad.startLine0,
            recentEdits: recentEdits.length,
            diagnostics: diagnostics.length,
            hasOriginalWindow: reconstructedOriginalWindowText !== undefined,
            originalSource: storedOriginalWindowText !== undefined ? 'snapshot' : reconstructedOriginalWindowText !== undefined ? 'reconstructed' : 'current-fallback',
        });
        return {
            windowText: window.text,
            windowStart: window.start,
            windowLineCount: window.lineCount,
            broadFileText: broad.text,
            broadFileStartLine: broad.startLine0,
            originalWindowText: reconstructedOriginalWindowText,
            cursorOffset: window.cursorOffset,
            recentEdits,
            diagnostics,
        };
    }

    /**
     * Собирает снимок и собранный контекст в единый SweepRequest для отправки на бекенд;
     * все поля необходимы для построения training-format промпта на стороне ноды.
     */
    request(model: monaco.editor.ITextModel, snapshot: SweepEditorSnapshot, collected: CollectedSweepContext): SweepRequest {
        const languageId = model.getLanguageId();
        const request = {
            requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            uri: model.uri.toString(),
            languageId,
            fileMode: fileModeForLanguage(languageId),
            windowText: snapshot.windowText,
            windowStart: snapshot.windowStart,
            broadFileText: snapshot.broadFileText,
            broadFileStartLine: snapshot.broadFileStartLine,
            originalWindowText: snapshot.originalWindowText,
            cursorOffset: snapshot.cursorOffset,
            recentEdits: snapshot.recentEdits,
            diagnostics: snapshot.diagnostics,
            relatedFiles: collected.relatedFiles,
            outline: collected.outline,
        };
        LOG.info('Sweep backend request built', {
            requestId: request.requestId,
            uri: request.uri,
            fileMode: request.fileMode,
            recentEdits: request.recentEdits.length,
            relatedFiles: request.relatedFiles.length,
            hasOutline: Boolean(request.outline),
        });
        return request;
    }
}

/**
 * Вырезает фиксированное окно текста вокруг курсора, которое Sweep будет переписывать
 * через блоки original/current/updated; размер окна влияет на качество и скорость предсказания.
 */
function editorWindow(model: monaco.editor.ITextModel, position: monaco.Position, beforeLines: number, afterLines: number): { text: string; start: { line: number; character: number }; cursorOffset: number; lineCount: number } {
    const startLineNumber = Math.max(1, position.lineNumber - beforeLines);
    const endLineNumber = Math.min(model.getLineCount(), position.lineNumber + afterLines);
    const range = {
        startLineNumber,
        startColumn: 1,
        endLineNumber,
        endColumn: model.getLineMaxColumn(endLineNumber),
    };
    const text = model.getValueInRange(range);
    const cursorOffset = model.getOffsetAt(position) - model.getOffsetAt({ lineNumber: startLineNumber, column: 1 });
    return { text, start: { line: startLineNumber - 1, character: 0 }, cursorOffset, lineCount: countLfLines(text) };
}

function editorProseWindow(model: monaco.editor.ITextModel, position: monaco.Position, beforeLines: number, afterLines: number): { text: string; start: { line: number; character: number }; cursorOffset: number; lineCount: number } {
    let startLineNumber = Math.max(1, position.lineNumber - beforeLines);
    let endLineNumber = Math.min(model.getLineCount(), position.lineNumber + afterLines);
    while (startLineNumber > 1 && !isBlankLine(model, startLineNumber - 1)) {
        startLineNumber--;
    }
    while (endLineNumber < model.getLineCount() && !isBlankLine(model, endLineNumber + 1)) {
        endLineNumber++;
    }
    const range = {
        startLineNumber,
        startColumn: 1,
        endLineNumber,
        endColumn: model.getLineMaxColumn(endLineNumber),
    };
    const text = model.getValueInRange(range);
    const cursorOffset = model.getOffsetAt(position) - model.getOffsetAt({ lineNumber: startLineNumber, column: 1 });
    return { text, start: { line: startLineNumber - 1, character: 0 }, cursorOffset, lineCount: countLfLines(text) };
}

function isBlankLine(model: monaco.editor.ITextModel, lineNumber: number): boolean {
    return model.getLineContent(lineNumber).trim().length === 0;
}

function editorBroadWindow(model: monaco.editor.ITextModel, position: monaco.Position, targetLines: number): { text: string; startLine0: number } {
    const safeLines = Math.max(1, targetLines);
    const before = Math.floor((safeLines - 1) / 2);
    const startLineNumber = Math.max(1, position.lineNumber - before);
    const endLineNumber = Math.min(model.getLineCount(), startLineNumber + safeLines - 1);
    const range = {
        startLineNumber,
        startColumn: 1,
        endLineNumber,
        endColumn: model.getLineMaxColumn(endLineNumber),
    };
    return { text: model.getValueInRange(range), startLine0: startLineNumber - 1 };
}

function countLfLines(text: string): number {
    let count = 1;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) {
            count++;
        }
    }
    return count;
}

/**
 * Преобразует Monaco-маркеры в протокольные DiagnosticDTO, чтобы они могли попасть
 * в диагностический псевдофайл промпта и в retrieval-сигналы для RAG-запроса.
 */
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
        LOG.debug('Sweep diagnostics collected from Monaco', { uri: model.uri.toString(), diagnostics: diagnostics.length });
    }
    return diagnostics;
}
