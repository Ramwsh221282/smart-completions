import type { DiagnosticDTO } from '../editor-dto';
import type { RecentEdit } from '../edit-history-types';
import { normalizeCrlf, splitLines } from '../text/crlf';
import { ZetaLogger } from './logger';

// Класс «тела» идентификатора для regex: латиница, кириллица, цифры, _ и $, чтобы edit-сигналы были полезны и для русскоязычного кода.
const ID_BODY = 'A-Za-z0-9_$\\u0410-\\u044F\\u0401\\u0451';
// Класс «начала» идентификатора исключает цифры, потому что число не должно попадать в сигналы как имя символа.
const ID_START = 'A-Za-z_$\\u0410-\\u044F\\u0401\\u0451';
// Глобальный matcher идентификаторов компилируется один раз вне горячих функций, чтобы diff-разбор не плодил новые RegExp.
const IDENT = new RegExp(`[${ID_START}][${ID_BODY}]*`, 'g');
// Не-глобальная проверка валидности имени нужна чтобы отсеять мусор из import/diagnostic парсинга.
const IDENT_AT = new RegExp(`[${ID_START}][${ID_BODY}]*`);
// Regex для импортов, деклараций и тестов вынесены в модульную область, чтобы hot path не пересоздавал их на каждый запрос.
const NAMED_IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s+from/g;
const DEFAULT_IMPORT_RE = new RegExp(`import\\s+([${ID_START}][${ID_BODY}]*)\\s+from`, 'g');
const REQUIRE_RE = new RegExp(`(?:const|let|var)\\s+([${ID_START}][${ID_BODY}]*)\\s*=\\s*require\\(`, 'g');
const AS_SPLIT_RE = /\s+as\s+/;
const DECLARED_TYPE_RE = new RegExp(`\\b(?:interface|class|type|enum|struct)\\s+([${ID_START}][${ID_BODY}]*)`, 'g');
const TEST_NAME_RE = /\b(?:describe|it|test)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const DIAGNOSTIC_QUOTED_RE = new RegExp(`['"\`]([${ID_START}][${ID_BODY}.]*)['"\`]`, 'g');
// Логгер сигналов показывает какие имена попали в retrieval query и почему модель увидела конкретный внешний контекст.
const LOG = new ZetaLogger('common:signals');

// Готовый набор сигналов питает graph/fuzzy каналы и строится один раз из zeta21 request вместо повторного парсинга в нескольких местах.
export interface ZetaSignalBundle {
    cursorSymbol: string;
    renamedSymbols: string[];
    diagnosticSymbols: string[];
    importedSymbols: string[];
    fuzzySymbols: string[];
}

// Минимальный shape для извлечения Zeta signal bundle; отделяет hot path от полного RPC-типа ZetaRequest.
export interface ZetaSignalInput {
    windowText: string;
    cursorOffset: number;
    recentEdits: RecentEdit[];
    diagnostics?: DiagnosticDTO[];
}

/** Извлекает identifier под курсором, чтобы retrieval начинался с самого точного edit-сигнала. */
export function symbolAtCursor(windowText: string, cursorOffset: number): string {
    const text = normalizeCrlf(windowText);
    const offset = Math.max(0, Math.min(cursorOffset, text.length));
    let start = offset;
    while (start > 0 && isIdentBodyChar(text.charCodeAt(start - 1))) {
        start--;
    }
    let end = offset;
    while (end < text.length && isIdentBodyChar(text.charCodeAt(end))) {
        end++;
    }
    while (start < end && isDigitCode(text.charCodeAt(start))) {
        start++;
    }
    const symbol = text.slice(start, end);
    if (process.env.NODE_ENV === 'development') {
        LOG.debug('symbol at cursor extracted', { symbol, cursorOffset: offset });
    }
    return symbol;
}

/** Извлекает импортируемые имена из окна, чтобы retrieval находил определения зависимостей напрямую связанных с текущим кодом. */
export function importedSymbols(text: string): string[] {
    const out = new Set<string>();
    const source = normalizeCrlf(text);
    for (let match = NAMED_IMPORT_RE.exec(source); match; match = NAMED_IMPORT_RE.exec(source)) {
        const parts = match[1].split(',');
        for (let i = 0; i < parts.length; i++) {
            const name = parts[i].trim().split(AS_SPLIT_RE).pop()?.trim();
            if (name && IDENT_AT.test(name)) {
                out.add(name);
            }
        }
    }
    for (let match = DEFAULT_IMPORT_RE.exec(source); match; match = DEFAULT_IMPORT_RE.exec(source)) {
        out.add(match[1]);
    }
    for (let match = REQUIRE_RE.exec(source); match; match = REQUIRE_RE.exec(source)) {
        out.add(match[1]);
    }
    const symbols = [...out];
    if (process.env.NODE_ENV === 'development') {
        LOG.debug('imported symbols extracted', { count: symbols.length, symbols });
    }
    return symbols;
}

/** Извлекает имена объявленных типов, потому что их реализации и расширения часто лежат в связанных внешних файлах. */
export function declaredTypeNames(text: string): string[] {
    const out = new Set<string>();
    const source = normalizeCrlf(text);
    for (let match = DECLARED_TYPE_RE.exec(source); match; match = DECLARED_TYPE_RE.exec(source)) {
        out.add(match[1]);
    }
    const names = [...out];
    if (process.env.NODE_ENV === 'development') {
        LOG.debug('declared type names extracted', { count: names.length, names });
    }
    return names;
}

/** Извлекает имена тестов из окна, потому что тестовые описания часто ведут к связанным production-файлам. */
export function testNames(text: string): string[] {
    const out = new Set<string>();
    const source = normalizeCrlf(text);
    for (let match = TEST_NAME_RE.exec(source); match; match = TEST_NAME_RE.exec(source)) {
        out.add(match[1].trim());
    }
    const names = [...out];
    if (process.env.NODE_ENV === 'development') {
        LOG.debug('test names extracted', { count: names.length, names });
    }
    return names;
}

/** Извлекает идентификаторы из текстов диагностик, чтобы retrieval видел символы упомянутые в ошибках компилятора. */
export function diagnosticSymbols(diagnostics: DiagnosticDTO[] | undefined): string[] {
    const out = new Set<string>();
    const list = diagnostics ?? [];
    for (let i = 0; i < list.length; i++) {
        const diagnostic = list[i];
        for (let match = DIAGNOSTIC_QUOTED_RE.exec(diagnostic.message); match; match = DIAGNOSTIC_QUOTED_RE.exec(diagnostic.message)) {
            const value = match[1];
            const dot = value.lastIndexOf('.');
            const name = dot >= 0 ? value.slice(dot + 1) : value;
            if (name && IDENT_AT.test(name)) {
                out.add(name);
            }
        }
    }
    const symbols = [...out];
    if (process.env.NODE_ENV === 'development') {
        LOG.debug('diagnostic symbols extracted', { count: symbols.length, symbols });
    }
    return symbols;
}

/** Извлекает идентификаторы которые появились или исчезли в recent diff-ах, чтобы capture-ить переименования и локальные рефакторинги. */
export function renamedSymbols(recentEdits: RecentEdit[]): string[] {
    const added = new Set<string>();
    const removed = new Set<string>();
    for (let i = 0; i < recentEdits.length; i++) {
        const edit = recentEdits[i];
        const lines = splitLines(edit.unifiedDiff);
        for (let j = 0; j < lines.length; j++) {
            const line = lines[j];
            if (line.startsWith('+') && !line.startsWith('+++')) {
                IDENT.lastIndex = 1;
                for (let match = IDENT.exec(line); match; match = IDENT.exec(line)) {
                    added.add(match[0]);
                }
                continue;
            }
            if (line.startsWith('-') && !line.startsWith('---')) {
                IDENT.lastIndex = 1;
                for (let match = IDENT.exec(line); match; match = IDENT.exec(line)) {
                    removed.add(match[0]);
                }
            }
        }
    }
    const changed = new Set<string>();
    for (const identifier of added) {
        if (!removed.has(identifier)) {
            changed.add(identifier);
        }
    }
    for (const identifier of removed) {
        if (!added.has(identifier)) {
            changed.add(identifier);
        }
    }
    const symbols = [...changed];
    if (process.env.NODE_ENV === 'development') {
        LOG.debug('renamed symbols extracted from recent edits', { count: symbols.length, symbols });
    }
    return symbols;
}

/** Возвращает хвост unified-diff истории правок, потому что самые свежие изменения лучше всего описывают текущее намерение пользователя. */
export function recentEditDiffTail(recentEdits: RecentEdit[], maxChars: number): string {
    const sorted = recentEdits.slice().sort((a, b) => a.timestamp - b.timestamp);
    const parts = new Array<string>(sorted.length);
    for (let i = 0; i < sorted.length; i++) {
        parts[i] = normalizeCrlf(sorted[i].unifiedDiff);
    }
    const tail = parts.join('\n\n').slice(-Math.max(0, maxChars));
    if (process.env.NODE_ENV === 'development') {
        LOG.debug('recent edit diff tail built', { edits: recentEdits.length, maxChars, actualChars: tail.length });
    }
    return tail;
}

/** Строит готовый набор graph/fuzzy сигналов одним проходом, чтобы backend не парсил request.windowText повторно в нескольких местах. */
export function extractZetaSignals(input: ZetaSignalInput): ZetaSignalBundle {
    const cursorSymbol = symbolAtCursor(input.windowText, input.cursorOffset);
    const renamed = renamedSymbols(input.recentEdits);
    const diagnostic = diagnosticSymbols(input.diagnostics);
    const imported = importedSymbols(input.windowText);
    const fuzzy = new Array<string>(1 + renamed.length + diagnostic.length);
    fuzzy[0] = cursorSymbol;
    let write = 1;
    for (let i = 0; i < renamed.length; i++) {
        fuzzy[write++] = renamed[i];
    }
    for (let i = 0; i < diagnostic.length; i++) {
        fuzzy[write++] = diagnostic[i];
    }
    return {
        cursorSymbol,
        renamedSymbols: renamed,
        diagnosticSymbols: diagnostic,
        importedSymbols: imported,
        fuzzySymbols: dedupeStrings(fuzzy),
    };
}

function isIdentBodyChar(code: number): boolean {
    return (code >= 48 && code <= 57)
        || (code >= 65 && code <= 90)
        || (code >= 97 && code <= 122)
        || code === 95 || code === 36
        || (code >= 0x0410 && code <= 0x044f)
        || code === 0x0401 || code === 0x0451;
}

function isDigitCode(code: number): boolean {
    return code >= 48 && code <= 57;
}

function dedupeStrings(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = 0; i < values.length; i++) {
        const value = values[i].trim();
        if (!value || seen.has(value)) {
            continue;
        }
        seen.add(value);
        out.push(value);
    }
    return out;
}
