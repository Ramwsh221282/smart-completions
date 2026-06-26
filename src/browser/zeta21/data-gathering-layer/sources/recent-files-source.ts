import URI from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import { EditorManager } from '@theia/editor/lib/browser';
import { ZetaLogger } from '../../../../common/zeta21/logger';
import type { RelatedCandidate } from '../../../../common/zeta21/related-files';
import type { RelatedSource, RelatedSourceContext } from './related-source';
import { WorkspaceFiles } from './workspace-files';

const LOG = new ZetaLogger('browser:data-gathering:recent-files-source');
const MAX_RECENT = 3;
const HEAD_LINES = 40;

/** Источник related-кандидатов из недавно открытых редакторов Theia; это дешёвый low-priority сигнал соседства. */
@injectable()
export class RecentFilesRelatedSource implements RelatedSource {
    readonly id = 'recent-files';

    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(WorkspaceFiles) protected readonly files!: WorkspaceFiles;

    /** Берёт заголовки недавно открытых файлов кроме текущего и отдаёт их как weak related сигнал со score=0. */
    async collect(ctx: RelatedSourceContext): Promise<RelatedCandidate[]> {
        const out: RelatedCandidate[] = [];
        const seen = new Set<string>();
        const widgets = this.editors.all;
        for (let i = 0; i < widgets.length && out.length < MAX_RECENT; i++) {
            const uri = new URI(widgets[i].editor.uri.toString());
            const rel = this.files.relativePath(uri);
            if (!rel || rel === ctx.currentRelPath || seen.has(rel)) {
                continue;
            }
            seen.add(rel);
            const head = await this.files.readHead(uri, HEAD_LINES);
            if (head) {
                out.push({ filePath: rel, content: head.content, startLine: head.startLine, endLine: head.endLine, score: 0 });
            }
        }
        LOG.info('Zeta recent-files candidates collected', { candidates: out.length });
        return out;
    }
}
