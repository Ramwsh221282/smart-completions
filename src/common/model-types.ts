// Идентификаторы моделей и режимов. Расширять слоты/окно сверх обученного запрещено.

/** Активная FIM-модель (по одной за раз). */
export type FimModelId =
    | 'qwen2.5-coder'
    | 'deepseek-coder'
    | 'omnicoder'
    | 'aixcoder-7b-v2'
    | 'granite-4.1-8b'
    | 'granite-4.1-3b'
    | 'seed-coder-8b';

/** Шаблон промпта FIM (общий для родственных моделей). */
export type FimTemplateId = 'qwen' | 'deepseek' | 'granite' | 'aixcoder' | 'seed';

// Список доступных NES-моделей хранится как const-кортеж, чтобы schema и тип не расходились.
export const NES_MODEL_IDS = ['sweep-default', 'sweep-small', 'zeta-2.1'] as const;

/** Активная NES-модель. Sweep и Zeta 2.1 имеют независимые frontend/backend pipelines. */
export type NesModelId = typeof NES_MODEL_IDS[number];

/** Sweep-модели обслуживаются через NesBackendService -> SweepBackendService. */
export type SweepNesModelId = Extract<NesModelId, 'sweep-default' | 'sweep-small'>;

/** Zeta 2.1 обслуживается через отдельный ZetaBackendService. */
export type Zeta21ModelId = Extract<NesModelId, 'zeta-2.1'>;

/** Шаблон промпта NES. Значения совпадают с modelId, чтобы не плодить второй роутинг. */
export type NesTemplateId = NesModelId;

/** Дискретный объём FIM-генерации. */
export type GenerationMode = 'line' | 'multiline' | 'block';

// Список допустимых режимов планирования хранится как const, чтобы schema и тип не расходились.
export const COMPLETION_SCHEDULING_MODES = ['parallel', 'idle-nes'] as const;

/**
 * Политика планирования FIM/NES без выключения одной подсистемы другой.
 * parallel — оба видимы одновременно; idle-nes — NES ждёт idle/debounce-паузу.
 */
export type CompletionSchedulingMode = typeof COMPLETION_SCHEDULING_MODES[number];

// Режимы маршрутизации NES через Rust core; const-кортеж держит schema и тип в синхроне.
export const CORE_NES_ROUTINGS = ['fallback', 'core-only'] as const;

/**
 * Маршрутизация NES при включённом Rust core.
 * fallback — при пустом core-результате идём в TS backend; core-only — TS NES path отключён.
 */
export type CoreNesRouting = typeof CORE_NES_ROUTINGS[number];

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
    'seed-coder-8b': 'seed',
};

/** Проверяет, является ли строка допустимым NES modelId; используется для валидации workspace preferences. */
export function isNesModelId(value: string): value is NesModelId {
    return value === 'sweep-default' || value === 'sweep-small' || value === 'zeta-2.1';
}

/** Проверяет, является ли NES modelId Sweep-специфичным; нужен для разветвления между Sweep и Zeta paths. */
export function isSweepNesModelId(value: string): value is SweepNesModelId {
    return value === 'sweep-default' || value === 'sweep-small';
}

/** Проверяет, является ли NES modelId Zeta 2.1; нужен для gating ZetaController и ZetaBackendService. */
export function isZeta21ModelId(value: string): value is Zeta21ModelId {
    return value === 'zeta-2.1';
}

/**
 * Нормализует любое значение completionSchedulingMode, включая legacy coordinationMode.
 * Используется как единственная точка миграции старых workspace settings.
 */
export function normalizeCompletionSchedulingMode(value: unknown): CompletionSchedulingMode {
    if (value === 'idle-nes') return 'idle-nes';
    if (value === 'parallel') return 'parallel';
    // Старый exclusive-priority означал «NES ждёт пока пользователь не прекратит набирать» —
    // это семантика idle-nes.
    if (value === 'exclusive-priority') return 'idle-nes';
    // Старые fim-only/nes-only/nes-priority были тестовыми артефактами;
    // для изоляции теперь используются fim.enabled / nes.enabled.
    return 'parallel';
}

/** Нормализует значение core NES routing; неизвестное значение деградирует к безопасному fallback. */
export function normalizeCoreNesRouting(value: unknown): CoreNesRouting {
    return value === 'core-only' ? 'core-only' : 'fallback';
}

export function isGraniteFimModel(modelId: FimModelId): boolean {
    return FIM_MODEL_TEMPLATE[modelId] === 'granite';
}

export function isAixcoderFimModel(modelId: FimModelId): boolean {
    return FIM_MODEL_TEMPLATE[modelId] === 'aixcoder';
}

export function isSeedFimModel(modelId: FimModelId): boolean {
    return FIM_MODEL_TEMPLATE[modelId] === 'seed';
}
