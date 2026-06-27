import type { FimTokenSet } from '../fim/fim-model-module';

export const SEED_FIM_SUFFIX = '<[fim-suffix]>';
export const SEED_FIM_PREFIX = '<[fim-prefix]>';
export const SEED_FIM_MIDDLE = '<[fim-middle]>';
export const SEED_EOS = '<[end▁of▁sentence]>';

export const SEED_TOKENS: FimTokenSet = {
    prefix: SEED_FIM_PREFIX,
    suffix: SEED_FIM_SUFFIX,
    middle: SEED_FIM_MIDDLE,
    extraStops: [SEED_FIM_SUFFIX, SEED_FIM_PREFIX, SEED_FIM_MIDDLE, SEED_EOS],
};

export const SEED_CONTEXT_TOKENS = 32768;
