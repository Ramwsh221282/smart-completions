import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging';
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
} from '../common/protocol';
import { EmbeddingIndexServiceImpl } from './services/embedding-index-service';
import { FimBackendServiceImpl } from './services/fim-backend-service';
import { NesBackendServiceImpl } from './services/nes-backend-service';
import { SweepGraphServiceImpl } from './services/sweep-graph-service';
import { FuzzyRetrievalChannel } from './sweep/retrieval/channels/fuzzy-retrieval-channel';
import { GraphRetrievalChannel } from './sweep/retrieval/channels/graph-retrieval-channel';
import { SemanticRetrievalChannel } from './sweep/retrieval/channels/semantic-retrieval-channel';
import { SweepFuzzyChannel } from './sweep/retrieval/fuzzy/sweep-fuzzy-channel';
import { SweepGraphChannel } from './sweep/retrieval/graph/sweep-graph-channel';
import { SweepGraphIndexer } from './sweep/retrieval/graph/sweep-graph-indexer';
import { RetrievalChannel } from './sweep/retrieval/retrieval-channel';
import { SweepRetrievalOrchestrator } from './sweep/retrieval/sweep-retrieval-orchestrator';
import { SweepBackendService } from './sweep/sweep-backend-service';

/**
 * Backend DI-модуль smart-completions.
 * Регистрирует RPC-сервисы FIM/NES-инференса и индексирования embedding-контекста.
 */
export default new ContainerModule(bind => {
    bind(FimBackendServiceImpl).toSelf().inSingletonScope();
    bind(FimBackendService).toService(FimBackendServiceImpl);

    bind(NesBackendServiceImpl).toSelf().inSingletonScope();
    bind(NesBackendService).toService(NesBackendServiceImpl);
    bind(SweepBackendService).toSelf().inSingletonScope();
    bind(SweepGraphServiceImpl).toSelf().inSingletonScope();
    bind(SweepGraphService).toService(SweepGraphServiceImpl);
    bind(SweepFuzzyChannel).toSelf().inSingletonScope();
    bind(SweepGraphIndexer).toSelf().inSingletonScope();
    bind(SweepGraphChannel).toSelf().inSingletonScope();

    bind(SemanticRetrievalChannel).toSelf().inSingletonScope();
    bind(RetrievalChannel).toService(SemanticRetrievalChannel);
    bind(GraphRetrievalChannel).toSelf().inSingletonScope();
    bind(RetrievalChannel).toService(GraphRetrievalChannel);
    bind(FuzzyRetrievalChannel).toSelf().inSingletonScope();
    bind(RetrievalChannel).toService(FuzzyRetrievalChannel);

    bind(SweepRetrievalOrchestrator).toSelf().inSingletonScope();

    bind(EmbeddingIndexServiceImpl).toSelf().inSingletonScope();
    bind(EmbeddingIndexService).toService(EmbeddingIndexServiceImpl);

    bind(ConnectionHandler)
        .toDynamicValue(ctx => new RpcConnectionHandler(FIM_SERVICE_PATH, () => ctx.container.get(FimBackendServiceImpl)))
        .inSingletonScope();

    bind(ConnectionHandler)
        .toDynamicValue(ctx => new RpcConnectionHandler(NES_SERVICE_PATH, () => ctx.container.get(NesBackendServiceImpl)))
        .inSingletonScope();

    bind(ConnectionHandler)
        .toDynamicValue(ctx => new RpcConnectionHandler(SWEEP_GRAPH_SERVICE_PATH, () => ctx.container.get(SweepGraphServiceImpl)))
        .inSingletonScope();

    bind(ConnectionHandler)
        .toDynamicValue(
            ctx =>
                new RpcConnectionHandler<EmbeddingIndexClient>(EMBEDDING_SERVICE_PATH, client => {
                    const service = ctx.container.get(EmbeddingIndexServiceImpl);
                    service.setClient(client);
                    return service;
                }),
        )
        .inSingletonScope();
});
