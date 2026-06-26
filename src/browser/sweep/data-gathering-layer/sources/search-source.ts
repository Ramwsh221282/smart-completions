import { SearchInWorkspaceService } from '@theia/search-in-workspace/lib/browser/search-in-workspace-service';
import { SearchInWorkspaceOptions, SearchInWorkspaceResult } from '@theia/search-in-workspace/lib/common/search-in-workspace-interface';
import { inject, injectable } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { SweepLogger } from '../../../../common/sweep/logger';
import { RelatedCandidate } from '../../../../common/sweep/related-files';
import { RelatedSource, RelatedSourceContext } from './related-source';
import { WorkspaceFiles } from './workspace-files';

// Ограничение числа запросов, чтобы поиск не занимал всё время debounce-окна Sweep.
const MAX_QUERIES = 4;
// Ограничение результатов на один запрос, чтобы один популярный символ не вытеснял все остальные файлы.
const MAX_RESULTS_PER_QUERY = 8;
// Радиус окна вокруг найденной строки; достаточен чтобы дать модели контекст без перегрузки промпта.
const WINDOW_RADIUS = 12;
// Таймаут защищает Sweep-триггер от зависания если поисковый индекс не отвечает.
const SEARCH_TIMEOUT_MS = 1500;
// Логгер поискового источника; нужен для диагностики какие запросы дали результаты.
const LOG = new SweepLogger('browser:data-gathering:search-source');

// Опции поиска: точное совпадение по словам и исключение шумных директорий для повышения точности результатов.
const SEARCH_OPTIONS: SearchInWorkspaceOptions = {
    maxResults: MAX_RESULTS_PER_QUERY,
    matchWholeWord: true,
    matchCase: true,
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/.git/**'],
};

/** Ищет файлы воркспейса по edit-signal символам чтобы найти связанные файлы для Sweep file-блоков. */
@injectable()
export class SearchRelatedSource implements RelatedSource {
    readonly id = 'search';

    // Theia-сервис полнотекстового поиска; нужен для нахождения файлов с похожими идентификаторами.
    @inject(SearchInWorkspaceService) protected readonly search!: SearchInWorkspaceService;
    // Утилита файловых операций; нужна для получения относительных путей и окон найденных файлов.
    @inject(WorkspaceFiles) protected readonly files!: WorkspaceFiles;

    /**
     * Выполняет несколько ограниченных символьных запросов и собирает файловые окна
     * вокруг совпадений, чтобы Sweep получил фрагменты файлов с реальным контекстом использования.
     */
    async collect(ctx: RelatedSourceContext): Promise<RelatedCandidate[]> {
        const { queries, currentRelPath } = ctx;
        const candidates: RelatedCandidate[] = [];
        for (let i = 0; i < queries.length && i < MAX_QUERIES; i++) {
            const query = queries[i];
            let results: SearchInWorkspaceResult[];
            try {
                results = await this.runSearch(query);
            } catch (error) {
                LOG.warn('Sweep search query failed', { query, error: error instanceof Error ? error.message : String(error) });
                continue;
            }
            for (const result of results) {
                const uri = new URI(result.fileUri);
                const rel = this.files.relativePath(uri);
                if (!rel || rel === currentRelPath) {
                    continue;
                }
                const firstLine = result.matches[0]?.line ?? 1;
                const window = await this.files.readWindow(uri, firstLine - 1, WINDOW_RADIUS);
                if (window) {
                    candidates.push({
                        filePath: rel,
                        content: window.content,
                        startLine: window.startLine,
                        endLine: window.endLine,
                        score: result.matches.length,
                    });
                }
            }
            if (process.env.NODE_ENV === 'development') {
                LOG.debug('Sweep search query completed', { query, results: results.length, candidates: candidates.length });
            }
        }
        LOG.info('Sweep search related candidates collected', { queries: queries.length, candidates: candidates.length });
        return candidates;
    }

    /**
     * Запускает один Theia-поисковый запрос с таймаутом, чтобы зависший индекс
     * не блокировал Sweep-триггер дольше SEARCH_TIMEOUT_MS.
     */
    private runSearch(what: string): Promise<SearchInWorkspaceResult[]> {
        return new Promise<SearchInWorkspaceResult[]>(resolve => {
            const results: SearchInWorkspaceResult[] = [];
            let activeId = -1;
            let settled = false;
            const finish = (): void => {
                if (!settled) {
                    settled = true;
                    resolve(results);
                }
            };
            const timer = setTimeout(finish, SEARCH_TIMEOUT_MS);
            this.search
                .search(
                    what,
                    {
                        onResult: (searchId: number, result: SearchInWorkspaceResult) => {
                            if (searchId === activeId) {
                                results.push(result);
                            }
                        },
                        onDone: (searchId: number) => {
                            if (searchId === activeId) {
                                clearTimeout(timer);
                                finish();
                            }
                        },
                    },
                    SEARCH_OPTIONS,
                )
                .then(searchId => {
                    activeId = searchId;
                })
                .catch(error => {
                    clearTimeout(timer);
                    LOG.warn('Sweep search service rejected query', { what, error: error instanceof Error ? error.message : String(error) });
                    finish();
                });
        });
    }
}
