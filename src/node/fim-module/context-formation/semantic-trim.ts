import { FileMode } from '../../../common/mode-types';

export interface TrimFimContextOptions {
    fileMode: FileMode;
    contextSize: number;
    reservedChars?: number;
}

export interface TrimmedFimContext {
    prefix: string;
    suffix: string;
}

const MIN_CONTEXT_CHARS = 512;
const CHARS_PER_TOKEN = 4;

const CODE_BOUNDARY = /(?:^|\n)[\t ]*(?:export[\t ]+)?(?:default[\t ]+)?(?:async[\t ]+)?(?:function|class|interface|type|enum|namespace|module|def|struct|impl|trait)\b/g;

export function trimFimContext(prefix: string, suffix: string, options: TrimFimContextOptions): TrimmedFimContext {
    const reservedChars = options.reservedChars ?? 0;
    // Repo-context съедает часть окна заранее, поэтому file-level prefix/suffix режем от остатка, а не от raw model context.
    const charBudget = Math.max(MIN_CONTEXT_CHARS, options.contextSize * CHARS_PER_TOKEN - reservedChars - 1024);
    // Префикс получает больший кусок бюджета: FIM сильнее зависит от ближайшего левого контекста у курсора.
    const prefixBudget = Math.max(256, Math.floor(charBudget * 0.65));
    const suffixBudget = Math.max(128, charBudget - prefixBudget);
    return {
        prefix: trimPrefix(prefix, prefixBudget, options.fileMode),
        suffix: trimSuffix(suffix, suffixBudget, options.fileMode),
    };
}

function trimPrefix(text: string, budget: number, fileMode: FileMode): string {
    if (text.length <= budget) {
        return text;
    }
    const tail = text.slice(-budget);
    if (fileMode === 'code') {
        // Для кода стараемся начать с declaration boundary, чтобы не отдавать модели случайный середняк блока.
        const boundary = lastCodeBoundary(tail);
        if (boundary > 0 && boundary < tail.length - 32) {
            return tail.slice(boundary);
        }
    } else {
        // Для prose лучше сохранять целый абзац, а не обрывок из середины текста.
        const paragraph = tail.search(/\n\s*\n/);
        if (paragraph >= 0 && paragraph < tail.length - 32) {
            return tail.slice(paragraph).replace(/^\n+/, '');
        }
    }
    const firstLineBreak = tail.indexOf('\n');
    return firstLineBreak >= 0 ? tail.slice(firstLineBreak + 1) : tail;
}

function trimSuffix(text: string, budget: number, fileMode: FileMode): string {
    if (text.length <= budget) {
        return text;
    }
    const head = text.slice(0, budget);
    if (fileMode === 'prose') {
        const paragraph = head.lastIndexOf('\n\n');
        if (paragraph > 32) {
            return head.slice(0, paragraph);
        }
    }
    const lastLineBreak = head.lastIndexOf('\n');
    return lastLineBreak > 32 ? head.slice(0, lastLineBreak) : head;
}

function lastCodeBoundary(text: string): number {
    let result = -1;
    CODE_BOUNDARY.lastIndex = 0;
    for (let match = CODE_BOUNDARY.exec(text); match; match = CODE_BOUNDARY.exec(text)) {
        result = match.index + (match[0].startsWith('\n') ? 1 : 0);
    }
    return result;
}
