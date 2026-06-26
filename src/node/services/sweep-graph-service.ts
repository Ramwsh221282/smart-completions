import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inject, injectable } from '@theia/core/shared/inversify';
import { SweepGraphService } from '../../common/protocol';
import { SweepGraphIndexer } from '../sweep/retrieval/graph/sweep-graph-indexer';

/** Backend RPC фасад управляет Sweep CodeGraph индексом без участия FIM/embedding services. */
@injectable()
export class SweepGraphServiceImpl implements SweepGraphService {
    private readonly cacheRoot = path.join(os.homedir(), '.theia', 'smart-completions', 'sweep-graph');

    /** Indexer владеет SQLite store, tree-sitter parsing и fuzzy catalog обновлениями. */
    constructor(@inject(SweepGraphIndexer) private readonly indexer: SweepGraphIndexer) {}

    /** Конфигурирует graph index по workspace roots; enabled=false закрывает store и очищает catalog. */
    async configure(workspaceRoots: string[], enabled: boolean): Promise<void> {
        const roots = new Array<string>(workspaceRoots.length);
        for (let i = 0; i < workspaceRoots.length; i++) {
            roots[i] = uriToFsPath(workspaceRoots[i]);
        }
        await this.indexer.configure(roots, this.cacheRoot, enabled);
    }

    /** Переиндексирует файл из live source или с диска, если source не передан. */
    async reindexFile(uri: string, source?: string, languageId?: string): Promise<void> {
        await this.indexer.reindexFile(uri, source, languageId);
    }
}

/** Конвертирует frontend file URI в fs-path для backend graph indexer. */
function uriToFsPath(uri: string): string {
    try {
        return uri.startsWith('file:') ? fileURLToPath(uri) : uri;
    } catch {
        return uri;
    }
}
