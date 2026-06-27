import type { FimTokenSet } from '../fim/fim-model-module';

export const QWEN_REPO_NAME_TOKEN = '<|repo_name|>';
export const QWEN_FILE_TOKEN = '<|file_sep|>';

export const QWEN_TOKENS: FimTokenSet = {
    prefix: '<|fim_prefix|>',
    suffix: '<|fim_suffix|>',
    middle: '<|fim_middle|>',
    extraStops: ['<|fim_pad|>', '<|endoftext|>', QWEN_FILE_TOKEN, QWEN_REPO_NAME_TOKEN],
};

export const DEEPSEEK_TOKENS: FimTokenSet = {
    prefix: '<｜fim▁begin｜>',
    suffix: '<｜fim▁hole｜>',
    middle: '<｜fim▁end｜>',
    extraStops: ['<｜end▁of▁sentence｜>', '<|endoftext|>'],
};
