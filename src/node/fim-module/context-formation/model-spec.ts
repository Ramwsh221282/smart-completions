import { FimModelId, FimTemplateId, GenerationMode } from '../../../common/model-types';

export interface FimTokenSet {
    prefix: string;
    suffix: string;
    middle: string;
    extraStops: string[];
}

export interface FimModelSpec {
    modelId: FimModelId;
    templateId: FimTemplateId;
    llamaModel: string;
    supportsRepoContext: boolean;
    tokens: FimTokenSet;
    repoNameToken?: string;
    fileToken?: string;
}

const QWEN_TOKENS: FimTokenSet = {
    prefix: '<|fim_prefix|>',
    suffix: '<|fim_suffix|>',
    middle: '<|fim_middle|>',
    extraStops: ['<|fim_pad|>', '<|endoftext|>', '<|file_sep|>', '<|repo_name|>'],
};

const DEEPSEEK_TOKENS: FimTokenSet = {
    prefix: '<｜fim▁begin｜>',
    suffix: '<｜fim▁hole｜>',
    middle: '<｜fim▁end｜>',
    extraStops: ['<｜end▁of▁sentence｜>', '<|endoftext|>'],
};

const GRANITE_TOKENS: FimTokenSet = {
    prefix: '<|fim_prefix|>',
    suffix: '<|fim_suffix|>',
    middle: '<|fim_middle|>',
    extraStops: ['<|fim_pad|>', '<|end_of_text|>', '<|endoftext|>', '<|filename|>', '<|reponame|>'],
};

const SPECS: Record<FimModelId, FimModelSpec> = {
    'qwen2.5-coder': {
        modelId: 'qwen2.5-coder',
        templateId: 'qwen',
        llamaModel: 'qwen2.5-coder',
        supportsRepoContext: true,
        tokens: QWEN_TOKENS,
        repoNameToken: '<|repo_name|>',
        fileToken: '<|file_sep|>',
    },
    omnicoder: {
        modelId: 'omnicoder',
        templateId: 'qwen',
        llamaModel: 'omnicoder',
        supportsRepoContext: true,
        tokens: QWEN_TOKENS,
        repoNameToken: '<|repo_name|>',
        fileToken: '<|file_sep|>',
    },
    'deepseek-coder': {
        modelId: 'deepseek-coder',
        templateId: 'deepseek',
        llamaModel: 'deepseek-coder',
        supportsRepoContext: false,
        tokens: DEEPSEEK_TOKENS,
    },
    'granite-4.1-8b': {
        modelId: 'granite-4.1-8b',
        templateId: 'granite',
        llamaModel: 'granite-4.1-8b',
        supportsRepoContext: true,
        tokens: GRANITE_TOKENS,
        repoNameToken: '<|reponame|>',
        fileToken: '<|filename|>',
    },
    'granite-4.1-3b': {
        modelId: 'granite-4.1-3b',
        templateId: 'granite',
        llamaModel: 'granite-4.1-3b',
        supportsRepoContext: true,
        tokens: GRANITE_TOKENS,
        repoNameToken: '<|reponame|>',
        fileToken: '<|filename|>',
    },
};

export function getFimModelSpec(modelId: FimModelId): FimModelSpec {
    return SPECS[modelId];
}

export function fimStopTokens(spec: FimModelSpec): string[] {
    // Бэк-токены модели всегда останавливают генерацию. Одиночный `\n` как серверный стоп
    // не используется: модели часто выдают ведущий перевод строки, из-за чего ответ
    // обрезается в пустую строку. Однострочный режим формируется в postprocess.
    const stops = [spec.tokens.prefix, spec.tokens.suffix, spec.tokens.middle, ...spec.tokens.extraStops];
    return Array.from(new Set(stops));
}

export function fimMaxTokens(generationMode: GenerationMode): number {
    switch (generationMode) {
        case 'line':
            return 48;
        case 'block':
            return 384;
        default:
            return 160;
    }
}
