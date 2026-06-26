import URI from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import { SearchInWorkspaceService } from '@theia/search-in-workspace/lib/browser/search-in-workspace-service';
import type { SearchInWorkspaceOptions, SearchInWorkspaceResult } from '@theia/search-in-workspace/lib/common/search-in-workspace-interface';
import type { RelatedCandidate } from '../../../../common/zeta21/related-files';
import { ZetaLogger } from '../../../../common/zeta21/logger';
import type { RelatedSource, RelatedSourceContext } from './related-source';
import { WorkspaceFiles } from './workspace-files';

// Ограничение числа запросов не даёт поиску занять всё debounce-окно zeta21-триггера.
const MAX_QUERIES = 4;
// Ограничение результатов на один запрос не позволяет одному популярному символу вытеснить все остальные файлы.
const MAX_RESULTS_PER_QUERY = 8;
// Радиус окна вокруг найденной строки достаточен чтобы дать модели локальный контекст без перегрузки prompt.
const WINDOW_RADIUS = 12;
// Таймаут защищает zeta21 trigger от подвисшего поискового индекса.
const SEARCH_TIMEOUT_MS = 1500;
// Логгер поискового источника нужен для диагностики того, какие символы дали реальные cross-file результаты.
const LOG = new ZetaLogger('browser:data-gathering:search-source');

// Опции поиска: точное совпадение по словам и исключение шумных директорий повышают точность результатов.
const SEARCH_OPTIONS: SearchInWorkspaceOptions = {
    maxResults: MAX_RESULTS_PER_QUERY,
    matchWholeWord: true,
    matchCase: true,
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/.git/**'],
};

/** Ищет файлы воркспейса по edit-signal символам чтобы найти связанные файлы для zeta21 prefix-блоков. */
@injectable()
export class SearchRelatedSource implements RelatedSource {
    readonly id = 'search';

    @inject(SearchInWorkspaceService) protected readonly search!: SearchInWorkspaceService;
    @inject(WorkspaceFiles) protected readonly files!: WorkspaceFiles;

    /** Выполняет несколько ограниченных символьных запросов и собирает файловые окна вокруг совпадений для zeta21 context slot. */
    async collect(ctx: RelatedSourceContext): Promise<RelatedCandidate[]> {
        const { queries, currentRelPath } = ctx;
        const candidates: RelatedCandidate[] = [];
        for (let i = 0; i < queries.length && i < MAX_QUERIES; i++) {
            const query = queries[i];
            let results: SearchInWorkspaceResult[];
            try {
                results = await this.runSearch(query);
            } catch (error) {
                LOG.warn('Zeta search query failed', { query, error: error instanceof Error ? error.message : String(error) });
                continue;
            }
            for (let j = 0; j < results.length; j++) {
                const result = results[j];
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
                LOG.debug('Zeta search query completed', { query, results: results.length, candidates: candidates.length });
            }
        }
        LOG.info('Zeta search related candidates collected', { queries: queries.length, candidates: candidates.length });
        return candidates;
    }

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
                    LOG.warn('Zeta search service rejected query', { what, error: error instanceof Error ? error.message : String(error) });
                    finish();
                });
        });
    }
}
