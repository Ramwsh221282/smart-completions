import { interfaces } from '@theia/core/shared/inversify';
import {
    RemoteConnectionProvider,
    ServiceConnectionProvider,
} from '@theia/core/lib/browser/messaging/service-connection-provider';
import {
    FimBackendService,
    FIM_SERVICE_PATH,
    NesBackendService,
    NES_SERVICE_PATH,
    EmbeddingIndexService,
    EmbeddingIndexClient,
    EMBEDDING_SERVICE_PATH,
    SweepGraphService,
    SWEEP_GRAPH_SERVICE_PATH,
    ZetaBackendService,
    ZETA_SERVICE_PATH,
} from '../common/protocol';
import { EmbeddingIndexClientImpl } from './embedding/index-client';

/**
 * Embedding proxy держит отдельный client-side callback object, потому что backend
 * пушит progress/status события обратно в frontend по тому же RPC-каналу.
 */
export function bindEmbeddingProxy(bind: interfaces.Bind): void {
    bind(EmbeddingIndexClientImpl).toSelf().inSingletonScope();
    bind(EmbeddingIndexClient).toService(EmbeddingIndexClientImpl);

    bind(EmbeddingIndexService)
        .toDynamicValue(ctx => {
            const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
            const client = ctx.container.get<EmbeddingIndexClient>(EmbeddingIndexClient);
            return provider.createProxy<EmbeddingIndexService>(EMBEDDING_SERVICE_PATH, client);
        })
        .inSingletonScope();
}

/** FIM proxy остаётся простым request/response биндингом без обратного client-канала. */
export function bindFimProxy(bind: interfaces.Bind): void {
    bind(FimBackendService)
        .toDynamicValue(ctx => {
            const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
            return provider.createProxy<FimBackendService>(FIM_SERVICE_PATH);
        })
        .inSingletonScope();
}

/** NES proxy идёт отдельным каналом, чтобы не смешивать lifecycle FIM и edit-suggestion backend paths. */
export function bindNesProxy(bind: interfaces.Bind): void {
    bind(NesBackendService)
        .toDynamicValue(ctx => {
            const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
            return provider.createProxy<NesBackendService>(NES_SERVICE_PATH);
        })
        .inSingletonScope();
}

/** Zeta proxy отделён от Sweep NES path, потому что у zeta21 свой backend pipeline и wire format. */
export function bindZetaProxy(bind: interfaces.Bind): void {
    bind(ZetaBackendService)
        .toDynamicValue(ctx => {
            const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
            return provider.createProxy<ZetaBackendService>(ZETA_SERVICE_PATH);
        })
        .inSingletonScope();
}

/** Sweep graph proxy живёт отдельно от inference-сервисов, потому что его lifecycle зависит от workspace indexing, а не от model requests. */
export function bindSweepGraphProxy(bind: interfaces.Bind): void {
    bind(SweepGraphService)
        .toDynamicValue(ctx => {
            const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
            return provider.createProxy<SweepGraphService>(SWEEP_GRAPH_SERVICE_PATH);
        })
        .inSingletonScope();
}
