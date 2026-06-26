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

/** Привязка RPC-прокси embedding-сервиса (electron-aware ServiceConnectionProvider). */
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

/** Привязка RPC-прокси FIM backend-сервиса. */
export function bindFimProxy(bind: interfaces.Bind): void {
    bind(FimBackendService)
        .toDynamicValue(ctx => {
            const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
            return provider.createProxy<FimBackendService>(FIM_SERVICE_PATH);
        })
        .inSingletonScope();
}

/** Привязка RPC-прокси NES backend-сервиса. */
export function bindNesProxy(bind: interfaces.Bind): void {
    bind(NesBackendService)
        .toDynamicValue(ctx => {
            const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
            return provider.createProxy<NesBackendService>(NES_SERVICE_PATH);
        })
        .inSingletonScope();
}

/** Привязка RPC-прокси Zeta backend-сервиса. */
export function bindZetaProxy(bind: interfaces.Bind): void {
    bind(ZetaBackendService)
        .toDynamicValue(ctx => {
            const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
            return provider.createProxy<ZetaBackendService>(ZETA_SERVICE_PATH);
        })
        .inSingletonScope();
}

/** Привязка RPC-прокси Sweep CodeGraph backend-сервиса. */
export function bindSweepGraphProxy(bind: interfaces.Bind): void {
    bind(SweepGraphService)
        .toDynamicValue(ctx => {
            const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
            return provider.createProxy<SweepGraphService>(SWEEP_GRAPH_SERVICE_PATH);
        })
        .inSingletonScope();
}
