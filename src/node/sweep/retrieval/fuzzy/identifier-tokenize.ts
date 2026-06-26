/** Identifier splitter выделяет части camelCase/snake-case/kebab-case для fuzzy symbol recall. */
const IDENTIFIER_PART_RE = /[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])|[\u0410-\u044F\u0401\u04510-9]+/g;

/** Возвращает исходный identifier и его под-токены без дублей для коротких fuzzy-запросов. */
export function splitIdentifier(identifier: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (value: string): void => {
        const token = value.trim();
        const key = token.toLowerCase();
        if (token.length > 1 && !seen.has(key)) {
            seen.add(key);
            out.push(token);
        }
    };
    add(identifier);
    const normalized = identifier.replace(/[_-]+/g, ' ');
    for (const segment of normalized.split(' ')) {
        IDENTIFIER_PART_RE.lastIndex = 0;
        for (let match = IDENTIFIER_PART_RE.exec(segment); match; match = IDENTIFIER_PART_RE.exec(segment)) {
            add(match[0]);
        }
    }
    return out;
}
