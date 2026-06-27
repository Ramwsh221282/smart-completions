import type { FimModelId } from '../../common/model-types';

// Node-слойный контракт модели: рантайм-проверки, которые нельзя/не нужно держать в common.
// Сейчас — health-check спец-токенов GGUF; это явная точка расширения для будущей node-специфики модели.
export interface FimNodeModule {
    modelId: FimModelId;
    // Probe-токены health-check; null = модель не требует проверки (стандартные токены).
    specialTokens: string[] | null;
    // Прогон health-check через общий верификатор. Для null-моделей — мгновенный true (no-op, но контракт явный).
    verifySpecialTokens(llamaUrl: string, signal?: AbortSignal): Promise<boolean>;
}
