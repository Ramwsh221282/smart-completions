import { inject, injectable } from '@theia/core/shared/inversify';
import { ScmService } from '@theia/scm/lib/browser/scm-service';
import type { RelatedCandidate } from '../../../../common/zeta21/related-files';
import { ZetaLogger } from '../../../../common/zeta21/logger';
import type { RelatedSource, RelatedSourceContext } from './related-source';
import { WorkspaceFiles } from './workspace-files';

// Ограничение числа co-changed файлов не даёт SCM-сигналу вытеснить более точные LSP/search кандидаты.
const MAX_CHANGED_FILES = 4;
// Число строк заголовка файла достаточно чтобы модель поняла назначение файла без чтения всего содержимого.
const HEAD_LINES = 40;
// Логгер SCM-источника нужен для диагностики того, какие dirty файлы попали в zeta21 контекст.
const LOG = new ZetaLogger('browser:data-gathering:scm-source');

/** Собирает dirty/co-changed файлы из SCM как низкоприоритетный сигнал связанности для zeta21 prefix-блоков. */
@injectable()
export class ScmChangedFilesSource implements RelatedSource {
    readonly id = 'scm';

    @inject(ScmService) protected readonly scm!: ScmService;
    @inject(WorkspaceFiles) protected readonly files!: WorkspaceFiles;

    /** Читает заголовки SCM-изменённых файлов потому что generic SCM API не отдаёт точных диффов, а хедера достаточно для weak related сигнала. */
    async collect(ctx: RelatedSourceContext): Promise<RelatedCandidate[]> {
        const { currentRelPath } = ctx;
        const candidates: RelatedCandidate[] = [];
        const seen = new Set<string>();
        try {
            const repositories = this.scm.repositories;
            for (let i = 0; i < repositories.length; i++) {
                const groups = repositories[i].provider.groups;
                for (let j = 0; j < groups.length; j++) {
                    const resources = groups[j].resources;
                    for (let k = 0; k < resources.length; k++) {
                        const rel = this.files.relativePath(resources[k].sourceUri);
                        if (!rel || rel === currentRelPath || seen.has(rel)) {
                            continue;
                        }
                        seen.add(rel);
                        const head = await this.files.readHead(resources[k].sourceUri, HEAD_LINES);
                        if (head) {
                            candidates.push({ filePath: rel, content: head.content, startLine: head.startLine, endLine: head.endLine, score: 0 });
                        }
                        if (candidates.length >= MAX_CHANGED_FILES) {
                            LOG.info('Zeta SCM candidates capped', { candidates: candidates.length });
                            return candidates;
                        }
                    }
                }
            }
        } catch (error) {
            if (process.env.NODE_ENV === 'development') {
                LOG.debug('Zeta SCM source unavailable', { error: error instanceof Error ? error.message : String(error) });
            }
        }
        LOG.info('Zeta SCM candidates collected', { candidates: candidates.length });
        return candidates;
    }
}
