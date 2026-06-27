import { getFimModule } from '../../../common/fim/fim-model-registry';
import type { FimRepoFormat, FimTokenSet } from '../../../common/fim/fim-model-module';
import type { FimModelId, FimTemplateId, GenerationMode } from '../../../common/model-types';

export interface FimModelSpec {
    modelId: FimModelId;
    templateId: FimTemplateId;
    llamaModel: string;
    supportsRepoContext: boolean;
    repoFormat: FimRepoFormat;
    tokens: FimTokenSet;
}

export function getFimModelSpec(modelId: FimModelId): FimModelSpec {
    const module = getFimModule(modelId);
    return {
        modelId: module.modelId,
        templateId: module.templateId,
        llamaModel: module.llamaModel,
        supportsRepoContext: module.supportsRepoContext,
        repoFormat: module.repoFormat,
        tokens: module.tokens,
    };
}

export function fimStopTokens(spec: FimModelSpec): string[] {
    // Бэк-токены модели всегда останавливают генерацию. Одиночный `\n` как серверный стоп
    // не используется: модели часто выдают ведущий перевод строки, из-за чего ответ
    // обрезается в пустую строку. Однострочный режим формируется в postprocess.
    const stops = [spec.tokens.prefix, spec.tokens.suffix, spec.tokens.middle, ...spec.tokens.extraStops];
    return Array.from(new Set(stops));
}

export function fimMaxTokens(spec: FimModelSpec, generationMode: GenerationMode): number {
    return getFimModule(spec.modelId).maxTokensForMode(generationMode);
}
