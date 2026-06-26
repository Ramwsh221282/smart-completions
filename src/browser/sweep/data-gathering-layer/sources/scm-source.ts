import { ScmService } from '@theia/scm/lib/browser/scm-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import { SweepLogger } from '../../../../common/sweep/logger';
import { RelatedCandidate } from '../../../../common/sweep/related-files';
import { WorkspaceFiles } from './workspace-files';

// Ограничение числа co-changed файлов, чтобы SCM-сигнал не вытеснял более точные LSP-кандидаты из промпта.
const MAX_CHANGED_FILES = 4;
// Число строк заголовка файла; достаточно чтобы модель поняла назначение файла без чтения всего содержимого.
const HEAD_LINES = 40;
// Логгер SCM-источника; нужен для диагностики того, какие грязные файлы попали в Sweep-контекст.
const LOG = new SweepLogger('browser:data-gathering:scm-source');

/** Собирает dirty/co-changed файлы из SCM как низкоприоритетный сигнал связанности для Sweep file-блоков. */
@injectable()
export class ScmChangedFilesSource {
    // Theia SCM-сервис; нужен для обхода репозиториев и получения списка изменённых файлов.
    @inject(ScmService) protected readonly scm!: ScmService;
    // Утилита файловых операций; нужна для получения относительных путей и заголовков файлов.
    @inject(WorkspaceFiles) protected readonly files!: WorkspaceFiles;

    /**
     * Читает заголовки SCM-изменённых файлов потому что generic SCM API не отдаёт точных диффов;
     * заголовок достаточен для понимания модели что это за файл и зачем он связан с текущей правкой.
     */
    async collect(currentRelPath: string): Promise<RelatedCandidate[]> {
        const candidates: RelatedCandidate[] = [];
        const seen = new Set<string>();
        try {
            for (const repository of this.scm.repositories) {
                for (const group of repository.provider.groups) {
                    for (const resource of group.resources) {
                        const rel = this.files.relativePath(resource.sourceUri);
                        if (!rel || rel === currentRelPath || seen.has(rel)) {
                            continue;
                        }
                        seen.add(rel);
                        const head = await this.files.readHead(resource.sourceUri, HEAD_LINES);
                        if (head) {
                            // score=0 означает низкий приоритет; LSP и search-кандидаты будут выше при ранжировании.
                            candidates.push({ filePath: rel, content: head.content, startLine: head.startLine, endLine: head.endLine, score: 0 });
                        }
                        if (candidates.length >= MAX_CHANGED_FILES) {
                            LOG.info('Sweep SCM candidates capped', { candidates: candidates.length });
                            return candidates;
                        }
                    }
                }
            }
        } catch (error) {
            if (process.env.NODE_ENV === 'development') {
                LOG.debug('Sweep SCM source unavailable', { error: error instanceof Error ? error.message : String(error) });
            }
        }
        LOG.info('Sweep SCM candidates collected', { candidates: candidates.length });
        return candidates;
    }
}
