import { inject, injectable } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import * as monaco from '@theia/monaco-editor-core';
import { DiagnosticDTO } from '../../../common/editor-dto';
import { RecentEdit } from '../../../common/edit-history-types';
import { buildRelatedFileQueries } from '../../../common/sweep/retrieval-queries';
import { dedupeRankRelated, RelatedCandidate } from '../../../common/sweep/related-files';
import { formatOutline } from '../../../common/sweep/outline';
import { SweepLogger } from '../../../common/sweep/logger';
import { SweepRelatedFile } from '../../../common/sweep/types';
import { HierarchyRelatedSource } from './sources/hierarchy-source';
import { ScmChangedFilesSource } from './sources/scm-source';
import { SearchRelatedSource } from './sources/search-source';
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
    outline?: string;
}

/** Координирует все best-effort источники Sweep-контекста и изолирует ошибки отдельных источников от основного потока. */
@injectable()
export class SweepContextCollector {
    // LSP / эвристика для построения outline псевдофайла в промпте.
    @inject(SymbolSource) protected readonly symbolSource!: SymbolSource;
    // Поиск по воркспейсу для нахождения файлов с похожими символами.
    @inject(SearchRelatedSource) protected readonly searchSource!: SearchRelatedSource;
    // Call/type hierarchy LSP для нахождения файлов-вызывателей и типов-родителей.
    @inject(HierarchyRelatedSource) protected readonly hierarchySource!: HierarchyRelatedSource;
    // SCM dirty-файлы как низкоприоритетный сигнал о co-changed зависимостях.
    @inject(ScmChangedFilesSource) protected readonly scmSource!: ScmChangedFilesSource;
    // Утилита для получения относительных путей и чтения окон файлов.
    @inject(WorkspaceFiles) protected readonly files!: WorkspaceFiles;

    /**
     * Запускает все источники контекста параллельно, подавляет ошибки каждого источника через safe/safeAsync,
     * дедуплицирует и ранжирует related-файлы, чтобы сбой одного источника не ломал весь Sweep-цикл.
     */
    async collect(params: CollectSweepContextParams): Promise<CollectedSweepContext> {
        const uri = new URI(params.model.uri.toString());
        const currentRel = this.safe(() => this.files.relativePath(uri), uri.path.base, 'relative-path');
        const cursorLine0 = params.position.lineNumber - 1;
        const lspPosition = { line: cursorLine0, character: params.position.column - 1 };

        const outline = await this.safeAsync(async () => {
            const symbols = await this.symbolSource.symbols(params.model);
            return symbols.length ? formatOutline(symbols, cursorLine0) : '';
        }, '', 'outline');

        const queries = buildRelatedFileQueries({
            recentEdits: params.recentEdits,
            windowText: params.windowText,
            cursorOffset: params.cursorOffset,
            diagnostics: params.diagnostics,
            maxChars: params.queryMaxChars,
        });

        const fromHierarchy = await this.safeAsync(
            () => this.hierarchySource.collect(params.languageId, uri, lspPosition, currentRel),
            [] as RelatedCandidate[],
            'hierarchy',
        );
        const fromSearch = await this.safeAsync(() => this.searchSource.collect(queries, currentRel), [] as RelatedCandidate[], 'search');
        const fromScm = await this.safeAsync(() => this.scmSource.collect(currentRel), [] as RelatedCandidate[], 'scm');

        const relatedCandidates: RelatedCandidate[] = [];
        pushAll(relatedCandidates, fromHierarchy);
        pushAll(relatedCandidates, fromSearch);
        pushAll(relatedCandidates, fromScm);
        const relatedFiles = dedupeRankRelated(relatedCandidates, params.relatedTopN);

        LOG.info('Sweep context collected', {
            currentRel,
            queries: queries.length,
            hierarchyCandidates: fromHierarchy.length,
            searchCandidates: fromSearch.length,
            scmCandidates: fromScm.length,
            relatedFiles: relatedFiles.length,
            hasOutline: Boolean(outline),
            diagnostics: params.diagnostics.length,
        });
        return { relatedFiles, outline: outline || undefined };
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

function pushAll<T>(target: T[], source: T[]): void {
    for (let i = 0; i < source.length; i++) {
        target.push(source[i]);
    }
}
