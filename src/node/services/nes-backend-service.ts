import { injectable, inject } from '@theia/core/shared/inversify';
import { CancellationToken } from '@theia/core/lib/common';
import { NesBackendService } from '../../common/protocol';
import { DEFAULT_DIAGNOSTICS_GATE_CONFIG, NesConfig, NesRequest, NesResponse } from '../../common/nes-types';
import { isSweepNesModelId } from '../../common/model-types';
import { getSweepProfile, sweepRequestModelName } from '../../common/sweep/profiles';
import { DEFAULT_SWEEP_FUZZY_CONFIG, DEFAULT_SWEEP_GRAPH_CONFIG, DEFAULT_SWEEP_RERANK_CONFIG, SweepConfig, SweepRequest } from '../../common/sweep/types';
import { SweepBackendService } from '../sweep/sweep-backend-service';

const DEFAULT_SWEEP_PROFILE = getSweepProfile('v2-7b');

// Дефолтный конфиг заменяет NesConfig при старте до первого configure(); должен быть Sweep-совместимым.
const DEFAULT_NES_CONFIG: NesConfig = {
    modelId: 'sweep-default',
    llamaUrl: 'http://127.0.0.1:8010/v1',
    contextSize: 16384,
    debounceMs: 500,
    editVolume: 'medium',
    ragEnabled: true,
    relatedTopN: 5,
    queryMaxChars: 400,
    profile: DEFAULT_SWEEP_PROFILE,
    requestModelName: sweepRequestModelName(DEFAULT_SWEEP_PROFILE.id, ''),
    rerank: DEFAULT_SWEEP_RERANK_CONFIG,
    graph: DEFAULT_SWEEP_GRAPH_CONFIG,
    fuzzy: DEFAULT_SWEEP_FUZZY_CONFIG,
    diagnosticsGate: DEFAULT_DIAGNOSTICS_GATE_CONFIG,
};

/**
 * Sweep-only фасад NES backend: принимает NesRequest/NesConfig и делегирует
 * в SweepBackendService только для sweep-default и sweep-small моделей.
 * Запросы с zeta-2.1 modelId приходить сюда не должны; они роутятся через ZetaBackendService.
 */
@injectable()
export class NesBackendServiceImpl implements NesBackendService {
    @inject(SweepBackendService) private readonly sweep!: SweepBackendService;

    private config = DEFAULT_NES_CONFIG;

    async configure(config: NesConfig): Promise<void> {
        this.config = clampContextSize(config);
        if (!isSweepNesModelId(this.config.modelId)) {
            return;
        }
        await this.sweep.configure(this.config as SweepConfig);
    }

    async predict(request: NesRequest, token?: CancellationToken): Promise<NesResponse> {
        if (!isSweepNesModelId(this.config.modelId)) {
            return emptyResponse(this.config.modelId);
        }
        return this.sweep.predict(request as SweepRequest, token);
    }
}

function clampContextSize(config: NesConfig): NesConfig {
    return { ...config, contextSize: Math.max(1024, config.contextSize) };
}

function emptyResponse(modelId: string): NesResponse {
    return { edits: [], modelId };
}
