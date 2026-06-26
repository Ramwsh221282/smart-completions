import URI from '@theia/core/lib/common/uri';
import { inject, injectable, multiInject } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import type { DiagnosticDTO } from '../../../common/editor-dto';
import type { RecentEdit } from '../../../common/edit-history-types';
import { dedupeRankRelated } from '../../../common/zeta21/related-files';
import { ZetaLogger } from '../../../common/zeta21/logger';
import { buildZetaRelatedFileQueries } from '../../../common/zeta21/retrieval-queries';
import type { ZetaRelatedFile } from '../../../common/zeta21/types';
import { collectRelatedCandidates } from './related-source-composite';
import { ZetaRelatedSource, type RelatedSource, type RelatedSourceContext } from './sources/related-source';
import { WorkspaceFiles } from './sources/workspace-files';

// Логгер сборщика контекста нужен для аудита того, какие related-источники реально сработали в zeta21 trigger.
const LOG = new ZetaLogger('browser:data-gathering:context-collector');

// Параметры запуска сбора zeta21-контекста после того как trigger зафиксировал позицию в редакторе.
export interface CollectZetaContextParams {
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

// Результат сбора контекста передаётся в ZetaRequestBuilder для финальной сборки RPC-запроса.
export interface CollectedZetaContext {
    relatedFiles: ZetaRelatedFile[];
}

/** Координирует все best-effort related-источники zeta21 и изолирует сбои отдельных источников от основного trigger-потока. */
@injectable()
export class ZetaContextCollector {
    @multiInject(ZetaRelatedSource) protected readonly relatedSources!: RelatedSource[];
    @inject(WorkspaceFiles) protected readonly files!: WorkspaceFiles;

    /** Собирает related-кандидаты best-effort так, чтобы сбой одного источника не прерывал zeta21-predict цикл. */
    async collect(params: CollectZetaContextParams): Promise<CollectedZetaContext> {
        const uri = new URI(params.model.uri.toString());
        const currentRel = this.safe(() => this.files.relativePath(uri), uri.path.base, 'relative-path');
        const queries = buildZetaRelatedFileQueries({
            recentEdits: params.recentEdits,
            windowText: params.windowText,
            cursorOffset: params.cursorOffset,
            diagnostics: params.diagnostics,
            maxChars: params.queryMaxChars,
        });
        const sourceCtx: RelatedSourceContext = {
            languageId: params.languageId,
            uri,
            position: { line: params.position.lineNumber - 1, character: params.position.column - 1 },
            currentRelPath: currentRel,
            queries,
        };
        const perSource: Record<string, number> = {};
        const relatedCandidates = await collectRelatedCandidates(this.relatedSources, sourceCtx, (id, error) => {
            LOG.warn('Zeta async context source failed', { label: id, error: error instanceof Error ? error.message : String(error) });
        }, (id, count) => {
            perSource[id] = count;
        });
        const relatedFiles = dedupeRankRelated(relatedCandidates, params.relatedTopN);
        LOG.info('Zeta context collected', {
            currentRel,
            queries: queries.length,
            perSource,
            relatedFiles: relatedFiles.length,
            diagnostics: params.diagnostics.length,
        });
        return { relatedFiles };
    }

    private safe<T>(fn: () => T, fallback: T, label: string): T {
        try {
            return fn();
        } catch (error) {
            LOG.warn('Zeta context source failed', { label, error: error instanceof Error ? error.message : String(error) });
            return fallback;
        }
    }
}
