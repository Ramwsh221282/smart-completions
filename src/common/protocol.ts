import { CancellationToken } from '@theia/core/lib/common/cancellation';
import { RpcServer } from '@theia/core/lib/common/messaging';
import { FimRequest, FimResponse, FimConfig } from './fim-types';
import { NesRequest, NesResponse, NesConfig } from './nes-types';
import {
    EmbeddingConfig,
    IndexStatus,
    IndexProgress,
    ConnTarget,
    TestResult,
} from './embedding-types';

// RPC-пути (websocket-мультиплекс Theia).
export const FIM_SERVICE_PATH = '/services/smart-completions/fim';
export const NES_SERVICE_PATH = '/services/smart-completions/nes';
export const EMBEDDING_SERVICE_PATH = '/services/smart-completions/embedding';
export const SWEEP_GRAPH_SERVICE_PATH = '/services/smart-completions/sweep-graph';

/** FIM-инференс (backend). context-formation + model-call внутри. */
export const FimBackendService = Symbol('FimBackendService');
export interface FimBackendService {
    complete(request: FimRequest, token?: CancellationToken): Promise<FimResponse>;
    configure(config: FimConfig): Promise<void>;
}

/** NES-инференс (backend). */
export const NesBackendService = Symbol('NesBackendService');
export interface NesBackendService {
    predict(request: NesRequest, token?: CancellationToken): Promise<NesResponse>;
    configure(config: NesConfig): Promise<void>;
}

/** Клиент embedding-сервиса: события статуса/прогресса (backend → frontend). */
export const EmbeddingIndexClient = Symbol('EmbeddingIndexClient');
export interface EmbeddingIndexClient {
    onStatusChanged(status: IndexStatus): void;
    onIndexProgress(progress: IndexProgress): void;
}

/** Управление индексом + retrieval-инфраструктурой (backend). */
export const EmbeddingIndexService = Symbol('EmbeddingIndexService');
export interface EmbeddingIndexService extends RpcServer<EmbeddingIndexClient> {
    rebuild(): Promise<void>;
    reindexFile(uri: string): Promise<void>;
    getStatus(): Promise<IndexStatus>;
    testConnection(target: ConnTarget): Promise<TestResult>;
    /** workspaceRoots — fs-пути корней воркспейса (frontend знает их из WorkspaceService). */
    configure(config: EmbeddingConfig, workspaceRoots: string[]): Promise<void>;
}

/** Управление Sweep CodeGraph индексом: full workspace configure и live/disk reindex файлов. */
export const SweepGraphService = Symbol('SweepGraphService');
export interface SweepGraphService {
    configure(workspaceRoots: string[], enabled: boolean): Promise<void>;
    reindexFile(uri: string, source?: string, languageId?: string): Promise<void>;
}
