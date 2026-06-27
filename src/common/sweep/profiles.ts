import type { SweepNesModelId } from '../model-types';

// `as const`-объект вместо enum, чтобы TypeScript не генерировал рантайм-объект и значения инлайнились в местах использования.
export const SWEEP_PROFILE_IDS = {
    v27b: 'v2-7b',
    small15b: '1.5b',
    small05b: '0.5b',
} as const;

// Строковый union допустимых ID профилей; не enum чтобы типы стирались при компиляции без рантайм-кода.
export type SweepProfileId = typeof SWEEP_PROFILE_IDS[keyof typeof SWEEP_PROFILE_IDS];

/**
 * Профиль конкретной Sweep-модели: параметры context window, окна триады и генерации.
 * Все поля инициализируются сразу чтобы V8 использовал один hidden class для всех профилей.
 */
export interface SweepModelProfile {
    /** Идентификатор профиля; нужен для логирования и роутинга внутри trimmer. */
    id: SweepProfileId;
    /** Верхняя граница context window; у малых моделей 8192 — переполнение промпта приводит к тихому обрезанию сервером. */
    contextTokens: number;
    /** Количество строк текущего файла вокруг курсора для первого wide file-блока промпта. */
    broadFileLines: number;
    /** Строк перед курсором в триаде; фиксировано по экспериментам Sweep (оптимум ≈10 для 7B, ≤8 для 0.5B). */
    windowBefore: number;
    /** Строк после курсора в триаде; симметрично windowBefore. */
    windowAfter: number;
    /** Лимит max_tokens в запросе к llama.cpp; защищает малые модели от ухода в бесконечную генерацию. */
    maxOutputTokens: number;
    /** Температура семплирования; 0 = greedy decoding согласно карточкам всех Sweep-моделей. */
    temperature: number;
}

// Публичные имена моделей на сервере llama.cpp; используются как дефолт для поля `model` в completion-запросе, если пользователь не задал своё.
export const SWEEP_MODEL_NAMES: Record<SweepProfileId, string> = {
    'v2-7b': 'sweep-next-edit-v2-7B',
    '1.5b': 'sweep-next-edit-1.5B',
    '0.5b': 'sweep-next-edit-0.5B',
};

// Реестр профилей, индексированный по SweepProfileId, для O(1)-доступа без итерации по массиву.
const SWEEP_PROFILES: Record<SweepProfileId, SweepModelProfile> = {
    'v2-7b': {
        id: 'v2-7b',
        contextTokens: 32768,
        broadFileLines: 300,
        windowBefore: 10,
        windowAfter: 10,
        maxOutputTokens: 1024,
        temperature: 0,
    },
    '1.5b': {
        id: '1.5b',
        contextTokens: 8192,
        broadFileLines: 160,
        windowBefore: 10,
        windowAfter: 10,
        maxOutputTokens: 768,
        temperature: 0,
    },
    '0.5b': {
        id: '0.5b',
        contextTokens: 8192,
        broadFileLines: 100,
        windowBefore: 8,
        windowAfter: 8,
        maxOutputTokens: 512,
        temperature: 0,
    },
};

/**
 * Единственная точка доступа к профилю по ID; изолирует реестр от прямых обращений
 * к SWEEP_PROFILES снаружи модуля.
 */
export function getSweepProfile(profileId: SweepProfileId): SweepModelProfile {
    return SWEEP_PROFILES[profileId];
}

/**
 * Резолвит ID профиля по modelId и под-настройке размера; sweep-small делится на 1.5B и 0.5B
 * с разными бюджетами контекста и генерации. Принимает только Sweep modelId — zeta-2.1 передавать нельзя.
 */
export function sweepProfileIdForModel(modelId: SweepNesModelId, smallSize: SweepProfileId): SweepProfileId {
    return modelId === 'sweep-small' ? smallSize : 'v2-7b';
}

/**
 * Возвращает имя модели для поля `model` в запросе к llama.cpp; пустая строка в preference
 * означает «использовать дефолт из профиля» чтобы не хардкодить имя в нескольких местах.
 */
export function sweepRequestModelName(profileId: SweepProfileId, configuredName: string): string {
    const trimmed = configuredName.trim();
    return trimmed || SWEEP_MODEL_NAMES[profileId];
}
