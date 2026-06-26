import { ContainerModule } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, KeybindingContribution } from '@theia/core/lib/browser';
import { CommandContribution } from '@theia/core/lib/common';
import { PreferenceContribution } from '@theia/core/lib/common/preferences/preference-schema';
import { SMART_COMPLETIONS_PREFERENCE_SCHEMA } from './preferences/preferences-schema';
import { bindEmbeddingProxy, bindFimProxy, bindNesProxy } from './proxies';
import { EmbeddingConfigSync } from './embedding/config-sync';
import { SmartCompletionsStatusBar } from './status-bar/status-bar';
import { SmartCompletionsCommands } from './commands';
import { FimInlineProvider } from './fim-module/fim-inline-provider';
import { NesController } from './nes-module/nes-controller';
import { NesViewZoneRenderer } from './nes-render/nes-view-zone-renderer';
import { SweepEditHistoryRecorder } from './sweep/data-gathering-layer/sweep-edit-history-recorder';
import { SweepContextCollector } from './sweep/data-gathering-layer/sweep-context-collector';
import { HierarchyRelatedSource } from './sweep/data-gathering-layer/sources/hierarchy-source';
import { OutputSource } from './sweep/data-gathering-layer/sources/output-source';
import { ScmChangedFilesSource } from './sweep/data-gathering-layer/sources/scm-source';
import { SearchRelatedSource } from './sweep/data-gathering-layer/sources/search-source';
import { SymbolSource } from './sweep/data-gathering-layer/sources/symbol-source';
import { WorkspaceFiles } from './sweep/data-gathering-layer/sources/workspace-files';
import { SweepTelemetry } from './sweep/telemetry/sweep-telemetry';

/**
 * Frontend DI-модуль smart-completions.
 * Подключает preferences, RPC-прокси, FIM ghost text, NES View Zone, embedding, статус-бар и команды.
 */
export default new ContainerModule(bind => {
    bind(PreferenceContribution).toConstantValue({ schema: SMART_COMPLETIONS_PREFERENCE_SCHEMA });

    bindFimProxy(bind);
    bindNesProxy(bind);
    bindEmbeddingProxy(bind);

    bind(SweepEditHistoryRecorder).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(SweepEditHistoryRecorder);

    bind(FimInlineProvider).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(FimInlineProvider);

    bind(WorkspaceFiles).toSelf().inSingletonScope();
    bind(SymbolSource).toSelf().inSingletonScope();
    bind(OutputSource).toSelf().inSingletonScope();
    bind(SearchRelatedSource).toSelf().inSingletonScope();
    bind(HierarchyRelatedSource).toSelf().inSingletonScope();
    bind(ScmChangedFilesSource).toSelf().inSingletonScope();
    bind(SweepContextCollector).toSelf().inSingletonScope();
    bind(SweepTelemetry).toSelf().inSingletonScope();

    bind(NesViewZoneRenderer).toSelf().inSingletonScope();
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
