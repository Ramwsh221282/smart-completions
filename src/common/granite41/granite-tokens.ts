import type { FimTokenSet } from '../fim/fim-model-module';

export const GRANITE_TOKENS: FimTokenSet = {
    prefix: '<|fim_prefix|>',
    suffix: '<|fim_suffix|>',
    middle: '<|fim_middle|>',
    extraStops: ['<|fim_pad|>', '<|end_of_text|>', '<|endoftext|>', '<|filename|>', '<|reponame|>'],
};
