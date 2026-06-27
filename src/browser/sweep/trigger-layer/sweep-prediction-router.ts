import type { CoreNesRouting } from '../../../common/model-types';
import type { NesResponse } from '../../../common/nes-types';

// Решение о маршрутизации одного NES-предсказания; вынесено из SweepController чтобы быть чистым и тестируемым.
export interface SweepPredictionRoute {
    coreEnabled: boolean;
    routing: CoreNesRouting;
}

/**
 * Разрешает одно NES-предсказание между Rust core и TS backend.
 * core-only держит TS NES path выключенным: пустой core-результат даёт отсутствие подсказки, а не fallback.
 */
export async function resolveSweepPrediction(
    route: SweepPredictionRoute,
    runCore: () => Promise<NesResponse | undefined>,
    runTs: () => Promise<NesResponse | undefined>,
): Promise<NesResponse | undefined> {
    if (!route.coreEnabled) {
        return runTs();
    }
    const fromCore = await runCore();
    if (fromCore !== undefined) {
        return fromCore;
    }
    if (route.routing === 'core-only') {
        return undefined;
    }
    return runTs();
}
