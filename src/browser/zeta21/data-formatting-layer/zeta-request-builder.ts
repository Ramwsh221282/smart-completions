import type * as monaco from '@theia/monaco-editor-core';
import type { DiagnosticDTO } from '../../../common/editor-dto';
import type { RecentEdit } from '../../../common/edit-history-types';
import { fileModeForLanguage } from '../../shared/file-mode';
import { buildRegions } from '../../../common/zeta21/markers';
import type { ZetaEditableRegion, ZetaRequest } from '../../../common/zeta21/types';
import { ZetaLogger } from '../../../common/zeta21/logger';
import type { CollectedZetaContext } from '../data-gathering-layer/zeta-context-collector';
import { ZetaSyntaxRegionResolver, type ResolvedSyntaxWindow } from './zeta-syntax-region-resolver';

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

// История правок нужна request builder только для чтения свежих diff-ов; отдельный интерфейс не привязывает builder к concrete recorder-реализации.
export interface ZetaRecentEditHistory {
    getRecentEdits(uri?: string, limit?: number): RecentEdit[];
}

// Resolver-абстракция позволяет тестировать builder без реального browser tree-sitter runtime.
export interface ZetaSyntaxWindowResolver {
    resolve(model: monaco.editor.ITextModel, position: monaco.Position, diagnostics: DiagnosticDTO[]): Promise<ResolvedSyntaxWindow | undefined>;
}

/** Строит снимок редактора до сбора контекста и финальный RPC-запрос после, разделяя две фазы zeta21 trigger-потока. */
export class ZetaRequestBuilder {
    constructor(private readonly syntaxResolver: ZetaSyntaxWindowResolver = new ZetaSyntaxRegionResolver()) {}

    /** Фиксирует состояние редактора в момент trigger и останавливает цикл если обязательная история правок пока пуста. */
    async snapshot(model: monaco.editor.ITextModel, position: monaco.Position, history: ZetaRecentEditHistory, diagnostics: DiagnosticDTO[]): Promise<ZetaEditorSnapshot | undefined> {
        const uri = model.uri.toString();
        const recentEdits = history.getRecentEdits(uri, 8);
        if (recentEdits.length === 0) {
            LOG.info('Zeta snapshot skipped because recent edit history is empty', { uri });
            return undefined;
        }
        const fileMode = fileModeForLanguage(model.getLanguageId());
        const syntaxWindow = fileMode === 'code'
            ? await this.syntaxResolver.resolve(model, position, diagnostics)
            : undefined;
        const region = syntaxWindow ?? (fileMode === 'prose' ? editorParagraph(model, position) : editorLine(model, position));
        const regions = buildRegions({ windowText: region.windowText, cursorOffset: region.cursorOffset, syntacticBounds: region.syntacticBounds });
        LOG.info('Zeta editor snapshot captured', {
            uri,
            fileMode,
            syntaxExpanded: syntaxWindow !== undefined,
            prefixChars: region.prefixText.length,
            windowChars: region.windowText.length,
            suffixChars: region.suffixText.length,
            regions: regions.length,
            recentEdits: recentEdits.length,
            diagnostics: diagnostics.length,
        });
        return {
            prefixText: region.prefixText,
            windowText: region.windowText,
            suffixText: region.suffixText,
            windowStart: region.windowStart,
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

function editorLine(model: monaco.editor.ITextModel, position: monaco.Position): ResolvedSyntaxWindow {
    const startLineNumber = position.lineNumber;
    const endLineNumber = position.lineNumber;
    const start = { lineNumber: startLineNumber, column: 1 };
    const end = { lineNumber: endLineNumber, column: model.getLineMaxColumn(endLineNumber) };
    const fullText = model.getValue();
    const startOffset = model.getOffsetAt(start);
    const endOffset = model.getOffsetAt(end);
    return {
        windowText: fullText.slice(startOffset, endOffset),
        windowStart: { line: startLineNumber - 1, character: 0 },
        cursorOffset: model.getOffsetAt(position) - startOffset,
        prefixText: fullText.slice(0, startOffset),
        suffixText: fullText.slice(endOffset),
        syntacticBounds: null,
    };
}

function editorParagraph(model: monaco.editor.ITextModel, position: monaco.Position): ResolvedSyntaxWindow {
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
    const fullText = model.getValue();
    const startOffset = model.getOffsetAt(start);
    const endOffset = model.getOffsetAt(end);
    return {
        windowText: fullText.slice(startOffset, endOffset),
        windowStart: { line: startLineNumber - 1, character: 0 },
        cursorOffset: model.getOffsetAt(position) - startOffset,
        prefixText: fullText.slice(0, startOffset),
        suffixText: fullText.slice(endOffset),
        syntacticBounds: null,
    };
}

function isBlankLine(model: monaco.editor.ITextModel, lineNumber: number): boolean {
    return model.getLineContent(lineNumber).trim().length === 0;
}
