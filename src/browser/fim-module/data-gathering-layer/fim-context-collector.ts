import URI from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import type { FimRelatedFile } from '../../../common/fim-types';
import type { RecentEdit } from '../../../common/edit-history-types';
import { dedupeRankRelated } from '../../../common/zeta21/related-files';
import { FimLogger } from '../../../common/fim/logger';
import { FimEditHistoryRecorder } from './fim-edit-history-recorder';
import { FimDefinitionRelatedSource } from './sources/definition-source';
import { FimWorkspaceFiles } from './sources/workspace-files';

const LOG = new FimLogger('browser:data-gathering:context-collector');
const MAX_FIM_RELATED_FILES = 6;

export interface CollectFimContextParams {
    model: monaco.editor.ITextModel;
    position: monaco.Position;
    collectRecentEdits: boolean;
    collectRelatedFiles: boolean;
}

export interface CollectedFimContext {
    recentEdits: RecentEdit[];
    relatedFiles: FimRelatedFile[];
}

@injectable()
export class FimContextCollector {
    @inject(FimDefinitionRelatedSource) protected readonly definitions!: FimDefinitionRelatedSource;
    @inject(FimEditHistoryRecorder) protected readonly history!: FimEditHistoryRecorder;
    @inject(FimWorkspaceFiles) protected readonly files!: FimWorkspaceFiles;

    async collect(params: CollectFimContextParams): Promise<CollectedFimContext> {
        const uri = new URI(params.model.uri.toString());
        const currentRel = this.safe(() => this.files.relativePath(uri), uri.path.base, 'relative-path');
        const sourceCtx = {
            uri,
            position: { line: params.position.lineNumber - 1, character: params.position.column - 1 },
            currentRelPath: currentRel,
        };
        const [relatedCandidates, recentEdits] = await Promise.all([
            params.collectRelatedFiles ? this.definitions.collect(sourceCtx) : Promise.resolve([]),
            Promise.resolve(params.collectRecentEdits ? this.history.getRecentEdits(params.model.uri.toString(), 8) : []),
        ]);
        const relatedFiles: FimRelatedFile[] = dedupeRankRelated(relatedCandidates, MAX_FIM_RELATED_FILES);
        LOG.info('FIM context collected', { relatedFiles: relatedFiles.length, recentEdits: recentEdits.length, currentRel });
        return { relatedFiles, recentEdits };
    }

    private safe<T>(fn: () => T, fallback: T, label: string): T {
        try {
            return fn();
        } catch (error) {
            LOG.warn('FIM context source failed', { label, error: error instanceof Error ? error.message : String(error) });
            return fallback;
        }
    }
}
