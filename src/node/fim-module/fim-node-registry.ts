import type { FimModelId } from '../../common/model-types';
import type { FimNodeModule } from './fim-node-module';
import { QWEN_NODE_MODULE, OMNICODER_NODE_MODULE } from '../qwen25/qwen-node-module';
import { DEEPSEEK_NODE_MODULE } from '../deepseek/deepseek-node-module';
import { GRANITE_8B_NODE_MODULE, GRANITE_3B_NODE_MODULE } from '../granite41/granite-node-module';
import { AIXCODER_NODE_MODULE } from '../aixcoder/aixcoder-node-module';
import { SEED_NODE_MODULE } from '../seedcoder/seed-node-module';

// Единая точка сборки node-модулей. Добавление модели = node-модуль + строка здесь (зеркало common-реестра).
const FIM_NODE_MODULES: Record<FimModelId, FimNodeModule> = {
    'qwen2.5-coder': QWEN_NODE_MODULE,
    'deepseek-coder': DEEPSEEK_NODE_MODULE,
    omnicoder: OMNICODER_NODE_MODULE,
    'aixcoder-7b-v2': AIXCODER_NODE_MODULE,
    'granite-4.1-8b': GRANITE_8B_NODE_MODULE,
    'granite-4.1-3b': GRANITE_3B_NODE_MODULE,
    'seed-coder-8b': SEED_NODE_MODULE,
};

export function getFimNodeModule(modelId: FimModelId): FimNodeModule {
    return FIM_NODE_MODULES[modelId];
}
