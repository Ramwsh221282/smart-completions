import { ContainerModule } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, KeybindingContribution } from '@theia/core/lib/browser';
import { CommandContribution } from '@theia/core/lib/common';
import { PreferenceContribution } from '@theia/core/lib/common/preferences/preference-schema';
import { SMART_COMPLETIONS_PREFERENCE_SCHEMA } from './preferences/preferences-schema';
import { bindCoreProxy, bindEmbeddingProxy, bindFimProxy, bindNesProxy, bindSweepGraphProxy, bindZetaProxy } from './proxies';
import { CoreDocumentSyncContribution } from './core/core-document-sync-contribution';
import { EmbeddingConfigSync } from './embedding/config-sync';
import { SmartCompletionsStatusBar } from './status-bar/status-bar';
import { SmartCompletionsCommands } from './commands';
import { FimContextCollector } from './fim-module/data-gathering-layer/fim-context-collector';
import { FimCompletionCache } from './fim-module/fim-completion-cache';
import { FimEditHistoryRecorder } from './fim-module/data-gathering-layer/fim-edit-history-recorder';
import { FimDefinitionRelatedSource } from './fim-module/data-gathering-layer/sources/definition-source';
import { FimWorkspaceFiles } from './fim-module/data-gathering-layer/sources/workspace-files';
import { FimInlineProvider } from './fim-module/fim-inline-provider';
import { NesController } from './nes-module/nes-controller';
import { NesViewZoneRenderer } from './nes-render/nes-view-zone-renderer';
import { SweepEditHistoryRecorder } from './sweep/data-gathering-layer/sweep-edit-history-recorder';
import { SweepContextCollector } from './sweep/data-gathering-layer/sweep-context-collector';
import { SweepGraphLiveRecorder } from './sweep/data-gathering-layer/sweep-graph-live-recorder';
import { HierarchyRelatedSource } from './sweep/data-gathering-layer/sources/hierarchy-source';
import { RelatedSource } from './sweep/data-gathering-layer/sources/related-source';
import { ScmChangedFilesSource } from './sweep/data-gathering-layer/sources/scm-source';
import { SearchRelatedSource } from './sweep/data-gathering-layer/sources/search-source';
import { SymbolSource } from './sweep/data-gathering-layer/sources/symbol-source';
import { WorkspaceFiles } from './sweep/data-gathering-layer/sources/workspace-files';
import { DiagnosticsDeltaVerifier } from './sweep/quality/diagnostics-delta-verifier';
import { SweepController } from './sweep/trigger-layer/sweep-controller';
import { ZetaContextCollector } from './zeta21/data-gathering-layer/zeta-context-collector';
import { ZetaEditHistoryRecorder } from './zeta21/data-gathering-layer/zeta-edit-history-recorder';
import { DefinitionRelatedSource } from './zeta21/data-gathering-layer/sources/definition-source';
import { HierarchyRelatedSource as ZetaHierarchyRelatedSource } from './zeta21/data-gathering-layer/sources/hierarchy-source';
import { RecentFilesRelatedSource } from './zeta21/data-gathering-layer/sources/recent-files-source';
import { ZetaRelatedSource } from './zeta21/data-gathering-layer/sources/related-source';
import { ScmChangedFilesSource as ZetaScmChangedFilesSource } from './zeta21/data-gathering-layer/sources/scm-source';
import { SearchRelatedSource as ZetaSearchRelatedSource } from './zeta21/data-gathering-layer/sources/search-source';
import { SymbolSource as ZetaSymbolSource } from './zeta21/data-gathering-layer/sources/symbol-source';
import { WorkspaceFiles as ZetaWorkspaceFiles } from './zeta21/data-gathering-layer/sources/workspace-files';
import { ZetaRequestBuilder } from './zeta21/data-formatting-layer/zeta-request-builder';
import { ZetaController } from './zeta21/trigger-layer/zeta-controller';

/**
 * Frontend DI-модуль smart-completions.
 * Подключает preferences, RPC-прокси, FIM ghost text, NES View Zone, embedding, статус-бар и команды.
 */
export default new ContainerModule(bind => {
    bind(PreferenceContribution).toConstantValue({ schema: SMART_COMPLETIONS_PREFERENCE_SCHEMA });

    bindFimProxy(bind);
    bindNesProxy(bind);
    bindZetaProxy(bind);
    bindEmbeddingProxy(bind);
    bindSweepGraphProxy(bind);
    bindCoreProxy(bind);

    bind(CoreDocumentSyncContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(CoreDocumentSyncContribution);

    bind(SweepEditHistoryRecorder).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(SweepEditHistoryRecorder);
    bind(ZetaEditHistoryRecorder).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ZetaEditHistoryRecorder);
    bind(SweepGraphLiveRecorder).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(SweepGraphLiveRecorder);

    bind(FimWorkspaceFiles).toSelf().inSingletonScope();
    bind(FimDefinitionRelatedSource).toSelf().inSingletonScope();
    bind(FimEditHistoryRecorder).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(FimEditHistoryRecorder);
    bind(FimCompletionCache).toSelf().inSingletonScope();
    bind(FimContextCollector).toSelf().inSingletonScope();

    bind(FimInlineProvider).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(FimInlineProvider);

    bind(WorkspaceFiles).toSelf().inSingletonScope();
    bind(SymbolSource).toSelf().inSingletonScope();
    bind(HierarchyRelatedSource).toSelf().inSingletonScope();
    bind(RelatedSource).toService(HierarchyRelatedSource);
    bind(SearchRelatedSource).toSelf().inSingletonScope();
    bind(RelatedSource).toService(SearchRelatedSource);
    bind(ScmChangedFilesSource).toSelf().inSingletonScope();
    bind(RelatedSource).toService(ScmChangedFilesSource);
    bind(SweepContextCollector).toSelf().inSingletonScope();

    bind(ZetaWorkspaceFiles).toSelf().inSingletonScope();
    bind(ZetaSymbolSource).toSelf().inSingletonScope();
    bind(DefinitionRelatedSource).toSelf().inSingletonScope();
    bind(ZetaRelatedSource).toService(DefinitionRelatedSource);
    bind(ZetaHierarchyRelatedSource).toSelf().inSingletonScope();
    bind(ZetaRelatedSource).toService(ZetaHierarchyRelatedSource);
    bind(ZetaSearchRelatedSource).toSelf().inSingletonScope();
    bind(ZetaRelatedSource).toService(ZetaSearchRelatedSource);
    bind(ZetaScmChangedFilesSource).toSelf().inSingletonScope();
    bind(ZetaRelatedSource).toService(ZetaScmChangedFilesSource);
    bind(RecentFilesRelatedSource).toSelf().inSingletonScope();
    bind(ZetaRelatedSource).toService(RecentFilesRelatedSource);
    bind(ZetaContextCollector).toSelf().inSingletonScope();
    bind(ZetaRequestBuilder).toSelf().inSingletonScope();

    bind(NesViewZoneRenderer).toSelf().inSingletonScope();
    bind(DiagnosticsDeltaVerifier).toSelf().inSingletonScope();
    bind(SweepController).toSelf().inSingletonScope();
    bind(ZetaController).toSelf().inSingletonScope();
    bind(NesController).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(NesController);

    bind(EmbeddingConfigSync).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(EmbeddingConfigSync);

    bind(SmartCompletionsStatusBar).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(SmartCompletionsStatusBar);

    bind(SmartCompletionsCommands).toSelf().inSingletonScope();
    bind(CommandContribution).toService(SmartCompletionsCommands);
    bind(KeybindingContribution).toService(SmartCompletionsCommands);
});
