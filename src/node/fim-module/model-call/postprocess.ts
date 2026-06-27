import type { GenerationMode } from '../../../common/model-types';
import { balanceCompletion } from './bracket-balance';
import { normalizeCrlf } from '../../util/crlf';

export interface PostprocessFimOptions {
    suffix: string;
    generationMode: GenerationMode;
    stopTokens: string[];
}

export function postprocessFimCompletion(rawText: string, options: PostprocessFimOptions): string {
    let text = normalizeCrlf(rawText);
    for (const token of options.stopTokens) {
        if (token === '\n') {
            continue;
        }
        const index = text.indexOf(token);
        if (index >= 0) {
            text = text.slice(0, index);
        }
    }
    text = stripCodeFence(text);
    if (options.generationMode === 'line') {
        // Срезаем ведущие переводы строк и оставляем первую содержательную строку.
        text = text.replace(/^\n+/, '');
        const newline = text.indexOf('\n');
        if (newline >= 0) {
            text = text.slice(0, newline);
        }
    }
    text = trimSuffixEcho(text, normalizeCrlf(options.suffix));
    text = balanceCompletion(text, normalizeCrlf(options.suffix));
    return text.trimEnd();
}

function stripCodeFence(text: string): string {
    // Chat-тюненные модели иногда оборачивают инфилл в markdown-ограждение ```; для кода это мусор.
    const opening = text.match(/^[ \t]*```[^\n]*\n/);
    if (opening) {
        text = text.slice(opening[0].length);
    }
    const close = text.indexOf('```');
    if (close >= 0) {
        text = text.slice(0, close);
    }
    return text;
}

function trimSuffixEcho(text: string, suffix: string): string {
    const max = Math.min(text.length, suffix.length, 240);
    for (let length = max; length > 0; length--) {
        if (text.endsWith(suffix.slice(0, length))) {
            return text.slice(0, -length);
        }
    }
    return text;
}
