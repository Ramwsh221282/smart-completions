import { inject, injectable, multiInject } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import * as monaco from '@theia/monaco-editor-core';
import { DiagnosticDTO } from '../../../common/editor-dto';
import { RecentEdit } from '../../../common/edit-history-types';
import { buildRelatedFileQueries } from '../../../common/sweep/retrieval-queries';
import { dedupeRankRelated, RelatedCandidate, selectRelatedCandidates } from '../../../common/sweep/related-files';
import { formatOutline, OutlineSymbol } from '../../../common/sweep/outline';
import { SweepLogger } from '../../../common/sweep/logger';
import { SweepRelatedFile } from '../../../common/sweep/types';
import { collectRelatedCandidates } from './related-source-composite';
import { RelatedSource, RelatedSourceContext } from './sources/related-source';
import { SymbolSource } from './sources/symbol-source';
import { WorkspaceFiles } from './sources/workspace-files';

// Логгер сборщика контекста; нужен для диагностики того, какие источники сработали и сколько кандидатов дали.
const LOG = new SweepLogger('browser:data-gathering:context-collector');

// Параметры для запуска сбора Sweep-контекста после того как триггер зафиксировал позицию в редакторе.
export interface CollectSweepContextParams {
    model: monaco.editor.ITextModel;
    position: monaco.Position;
    languageId: string;
    windowText: string;
    cursorOffset: number;
    recentEdits: RecentEdit[];
    diagnostics: DiagnosticDTO[];
    relatedTopN: number;
    queryMaxChars: number;
}

// Результат сбора контекста; передаётся в SweepRequestBuilder для финальной сборки RPC-запроса.
export interface CollectedSweepContext {
    relatedFiles: SweepRelatedFile[];
    selectedRelatedCandidates: RelatedCandidate[];
    outline?: string;
    outlineSymbols?: OutlineSymbol[];
}

/** Координирует все best-effort источники Sweep-контекста и изолирует ошибки отдельных источников от основного потока. */
@injectable()
export class SweepContextCollector {
    // LSP / эвристика для построения outline псевдофайла в промпте.
    @inject(SymbolSource) protected readonly symbolSource!: SymbolSource;
    // Все related-источники инжектятся в порядке bind(...).toService(...); этот порядок участвует в tie-break.
    @multiInject(RelatedSource) protected readonly relatedSources!: RelatedSource[];
    // Утилита для получения относительных путей и чтения окон файлов.
    @inject(WorkspaceFiles) protected readonly files!: WorkspaceFiles;

    /**
     * Собирает outline и related-кандидаты best-effort так, чтобы сбой одного источника
     * не прерывал Sweep-цикл и не менял детерминированный порядок related-кандидатов.
     */
    async collect(params: CollectSweepContextParams): Promise<CollectedSweepContext> {
        const uri = new URI(params.model.uri.toString());
        const currentRel = this.safe(() => this.files.relativePath(uri), uri.path.base, 'relative-path');
        const cursorLine0 = params.position.lineNumber - 1;
        const lspPosition = { line: cursorLine0, character: params.position.column - 1 };

        const outlineSymbols = await this.safeAsync(() => this.symbolSource.symbols(params.model), [], 'outline');
        const outline = outlineSymbols.length ? formatOutline(outlineSymbols, cursorLine0) : '';

        const queries = buildRelatedFileQueries({
            recentEdits: params.recentEdits,
            windowText: params.windowText,
            cursorOffset: params.cursorOffset,
            diagnostics: params.diagnostics,
            maxChars: params.queryMaxChars,
        });

        const sourceCtx: RelatedSourceContext = {
            languageId: params.languageId,
            uri,
            position: lspPosition,
            currentRelPath: currentRel,
            queries,
        };
        const perSource: Record<string, number> = {};
        const relatedCandidates = await collectRelatedCandidates(this.relatedSources, sourceCtx, (id, error) => {
            LOG.warn('Sweep async context source failed', { label: id, error: error instanceof Error ? error.message : String(error) });
        }, (id, count) => {
            perSource[id] = count;
        });
        const selectedRelatedCandidates = selectRelatedCandidates(relatedCandidates, params.relatedTopN);
        const relatedFiles = dedupeRankRelated(relatedCandidates, params.relatedTopN);

        LOG.info('Sweep context collected', {
            currentRel,
            queries: queries.length,
            perSource,
            relatedFiles: relatedFiles.length,
            hasOutline: Boolean(outline),
            diagnostics: params.diagnostics.length,
        });
        return {
            relatedFiles,
            selectedRelatedCandidates,
            outline: outline || undefined,
            outlineSymbols: outlineSymbols.length ? outlineSymbols : undefined,
        };
    }

    /**
     * Оборачивает синхронный источник контекста в try/catch и возвращает fallback,
     * чтобы сбой одного источника не прерывал весь цикл Sweep-предсказания.
     */
    private safe<T>(fn: () => T, fallback: T, label: string): T {
        try {
            return fn();
        } catch (error) {
            LOG.warn('Sweep context source failed', { label, error: error instanceof Error ? error.message : String(error) });
            return fallback;
        }
    }

    /**
     * Оборачивает асинхронный источник контекста в try/catch и возвращает fallback,
     * чтобы сбой одного источника не прерывал весь цикл Sweep-предсказания.
     */
    private async safeAsync<T>(fn: () => Promise<T>, fallback: T, label: string): Promise<T> {
        try {
            return await fn();
        } catch (error) {
            LOG.warn('Sweep async context source failed', { label, error: error instanceof Error ? error.message : String(error) });
            return fallback;
        }
    }
}
