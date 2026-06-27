// Срезаем только хвостовые закрывающие скобки, которые completion дублирует из suffix.
// Консервативный fail-mode: при неоднозначности ничего не трогаем, чтобы не ломать код.

const CLOSE_TO_OPEN: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const OPENERS: Record<string, true> = { '(': true, '[': true, '{': true };
const CLOSERS: Record<string, true> = { ')': true, ']': true, '}': true };

export function balanceCompletion(text: string, suffix: string): string {
    if (text.length === 0 || suffix.length === 0) {
        return text;
    }
    const trailingClosers = scanTrailingUnmatchedClosers(text);
    if (trailingClosers.length === 0) {
        return text;
    }
    const suffixClosers = leadingCloserRun(suffix);
    if (suffixClosers.length === 0) {
        return text;
    }
    const overlap = matchingTrailingCloserCount(trailingClosers, suffixClosers);
    if (overlap === 0) {
        return text;
    }
    return trimTrailingClosers(text, overlap);
}

function scanTrailingUnmatchedClosers(text: string): string[] {
    const unmatchedClosers = new Set<number>();
    const stack: string[] = [];
    let inString: string | null = null;
    let inLineComment = false;
    let inBlockComment = false;

    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        const next = index + 1 < text.length ? text[index + 1] : '';
        if (inLineComment) {
            if (char === '\n') {
                inLineComment = false;
            }
            continue;
        }
        if (inBlockComment) {
            if (char === '*' && next === '/') {
                inBlockComment = false;
                index++;
            }
            continue;
        }
        if (inString !== null) {
            if (char === '\\') {
                index++;
                continue;
            }
            if (char === inString) {
                inString = null;
            }
            continue;
        }
        if (char === '/' && next === '/') {
            inLineComment = true;
            index++;
            continue;
        }
        if (char === '/' && next === '*') {
            inBlockComment = true;
            index++;
            continue;
        }
        if (char === '"' || char === '\'' || char === '`') {
            inString = char;
            continue;
        }
        if (OPENERS[char]) {
            stack.push(char);
            continue;
        }
        if (!CLOSERS[char]) {
            continue;
        }
        if (stack.length === 0) {
            unmatchedClosers.add(index);
            continue;
        }
        const expectedOpener = CLOSE_TO_OPEN[char];
        if (stack[stack.length - 1] === expectedOpener) {
            stack.pop();
        }
    }

    return collectTrailingUnmatchedClosers(text, unmatchedClosers);
}

function collectTrailingUnmatchedClosers(text: string, unmatchedClosers: Set<number>): string[] {
    const reversedClosers: string[] = [];
    for (let index = text.length - 1; index >= 0; index--) {
        const char = text[index];
        if (isTrimWhitespace(char)) {
            continue;
        }
        if (!CLOSERS[char] || !unmatchedClosers.has(index)) {
            break;
        }
        reversedClosers.push(char);
    }
    reversedClosers.reverse();
    return reversedClosers;
}

function leadingCloserRun(suffix: string): string[] {
    const closers: string[] = [];
    for (let index = 0; index < suffix.length; index++) {
        const char = suffix[index];
        if (isTrimWhitespace(char)) {
            continue;
        }
        if (!CLOSERS[char]) {
            break;
        }
        closers.push(char);
    }
    return closers;
}

function matchingTrailingCloserCount(textClosers: string[], suffixClosers: string[]): number {
    const max = Math.min(textClosers.length, suffixClosers.length);
    for (let count = max; count > 0; count--) {
        let matched = true;
        const offset = textClosers.length - count;
        for (let index = 0; index < count; index++) {
            if (textClosers[offset + index] !== suffixClosers[index]) {
                matched = false;
                break;
            }
        }
        if (matched) {
            return count;
        }
    }
    return 0;
}

function trimTrailingClosers(text: string, count: number): string {
    let end = text.length;
    let removed = 0;
    while (end > 0 && removed < count) {
        const char = text[end - 1];
        if (isTrimWhitespace(char)) {
            end--;
            continue;
        }
        if (!CLOSERS[char]) {
            break;
        }
        end--;
        removed++;
    }
    return text.slice(0, end);
}

function isTrimWhitespace(char: string): boolean {
    return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}
