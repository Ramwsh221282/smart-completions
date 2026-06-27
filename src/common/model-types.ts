// Идентификаторы моделей и режимов. Расширять слоты/окно сверх обученного запрещено.

/** Активная FIM-модель (по одной за раз). */
export type FimModelId =
    | 'qwen2.5-coder'
    | 'deepseek-coder'
    | 'omnicoder'
    | 'aixcoder-7b-v2'
    | 'granite-4.1-8b'
    | 'granite-4.1-3b';

/** Шаблон промпта FIM (общий для родственных моделей). */
export type FimTemplateId = 'qwen' | 'deepseek' | 'granite' | 'aixcoder';

/** Активная NES-модель (по одной за раз). */
export type NesModelId = 'sweep-default' | 'sweep-small' | 'zeta' | 'zeta-2.1';

/** Шаблон промпта NES. */
export type NesTemplateId = 'sweep-default' | 'sweep-small' | 'zeta' | 'zeta-2.1';

/** Дискретный объём FIM-генерации. */
export type GenerationMode = 'line' | 'multiline' | 'block';

/** Политика совмещения FIM и NES (читается внутри nes-trigger, без арбитра). */
export type CoordinationMode =
    | 'exclusive-priority' // деф: набор→FIM, пауза/после-accept→NES; не оба сразу
    | 'parallel' // оба видимы одновременно, разные кейбайндинги
    | 'fim-only'
    | 'nes-only'
    | 'nes-priority';

/**
 * Embedding-модель. Свободная строка — имя модели для llama.cpp /v1/embeddings.
 * Не ограничиваем набор: можно подключить любую embedding-модель.
 * Известные псевдонимы ('nomic', 'granite') разворачиваются в полные имена; любая
 * другая строка уходит в запрос как есть.
 */
export type EmbedModelId = string;

/** Векторное хранилище. */
export type VectorDbId = 'lancedb' | 'chromadb';

/** Сопоставление FIM-модели → шаблон. */
export const FIM_MODEL_TEMPLATE: Record<FimModelId, FimTemplateId> = {
    'qwen2.5-coder': 'qwen',
    omnicoder: 'qwen',
    'deepseek-coder': 'deepseek',
    'aixcoder-7b-v2': 'aixcoder',
    'granite-4.1-8b': 'granite',
    'granite-4.1-3b': 'granite',
};

export function isGraniteFimModel(modelId: FimModelId): boolean {
    return FIM_MODEL_TEMPLATE[modelId] === 'granite';
}

export function isAixcoderFimModel(modelId: FimModelId): boolean {
    return FIM_MODEL_TEMPLATE[modelId] === 'aixcoder';
}
