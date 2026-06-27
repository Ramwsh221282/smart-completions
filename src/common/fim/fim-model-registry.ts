import type { FimModelId } from '../model-types';
import { AIXCODER_MODULE } from '../aixcoder/aixcoder-module';
import { DEEPSEEK_MODULE } from '../deepseek/deepseek-module';
import type { FimModelModule } from './fim-model-module';
import { GRANITE_3B_MODULE, GRANITE_8B_MODULE } from '../granite41/granite-module';
import { OMNICODER_MODULE, QWEN_MODULE } from '../qwen25/qwen-module';
import { SEED_MODULE } from '../seedcoder/seed-module';

export const FIM_MODEL_IDS = [
    'qwen2.5-coder',
    'deepseek-coder',
    'omnicoder',
    'aixcoder-7b-v2',
    'granite-4.1-8b',
    'granite-4.1-3b',
    'seed-coder-8b',
] as const satisfies readonly FimModelId[];

const FIM_MODULES: Record<FimModelId, FimModelModule> = {
    'qwen2.5-coder': QWEN_MODULE,
    'deepseek-coder': DEEPSEEK_MODULE,
    omnicoder: OMNICODER_MODULE,
    'aixcoder-7b-v2': AIXCODER_MODULE,
    'granite-4.1-8b': GRANITE_8B_MODULE,
    'granite-4.1-3b': GRANITE_3B_MODULE,
    'seed-coder-8b': SEED_MODULE,
};

export function getFimModule(modelId: FimModelId): FimModelModule {
    return FIM_MODULES[modelId];
}
