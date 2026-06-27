export const AIX_SPAN_PRE = '\u2581<AIX-SPAN-PRE>';
export const AIX_SPAN_POST = '\u2581<AIX-SPAN-POST>';
export const AIX_SPAN_MIDDLE = '\u2581<AIX-SPAN-MIDDLE>';
export const AIX_EOS = '</s>';

export const AIXCODER_TOKENS = {
    prefix: AIX_SPAN_PRE,
    suffix: AIX_SPAN_POST,
    middle: AIX_SPAN_MIDDLE,
    extraStops: [AIX_EOS, AIX_SPAN_PRE, AIX_SPAN_POST, AIX_SPAN_MIDDLE],
};

export const AIXCODER_CONTEXT_TOKENS = 32768;
