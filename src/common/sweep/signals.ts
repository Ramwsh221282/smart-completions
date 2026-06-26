import { RecentEdit } from '../edit-history-types';
import { DiagnosticDTO } from '../editor-dto';
import { normalizeCrlf, splitLines } from '../text/crlf';
import { SweepLogger } from './logger';

// Класс «тела» идентификатора для regex: латиница, кириллица (включая Ёё), цифры, _ и $. Кириллица нужна для кода/документов на русском.
const ID_BODY = 'A-Za-z0-9_$\\u0410-\\u044F\\u0401\\u0451';
// Класс «начала» идентификатора: то же что тело, но без цифр — идентификатор не может начинаться с цифры.
const ID_START = 'A-Za-z_$\\u0410-\\u044F\\u0401\\u0451';
// Глобальный matcher идентификаторов для извлечения всех имён из строки диффа; компилируется один раз вне горячих функций.
const IDENT = new RegExp(`[${ID_START}][${ID_BODY}]*`, 'g');
// Не-глобальная проверка «содержит ли строка валидный идентификатор»; используется для отсева мусорных имён.
const IDENT_AT = new RegExp(`[${ID_START}][${ID_BODY}]*`);
// Регэкспы импортов/деклараций/тестов вынесены в модульную область (правило 7): не пересоздаём их на каждый вызов функции.
const NAMED_IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s+from/g;
const DEFAULT_IMPORT_RE = new RegExp(`import\\s+([${ID_START}][${ID_BODY}]*)\\s+from`, 'g');
const REQUIRE_RE = new RegExp(`(?:const|let|var)\\s+([${ID_START}][${ID_BODY}]*)\\s*=\\s*require\\(`, 'g');
const AS_SPLIT_RE = /\s+as\s+/;
const DECLARED_TYPE_RE = new RegExp(`\\b(?:interface|class|type|enum|struct)\\s+([${ID_START}][${ID_BODY}]*)`, 'g');
const TEST_NAME_RE = /\b(?:describe|it|test)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const DIAGNOSTIC_QUOTED_RE = new RegExp(`['"\`]([${ID_START}][${ID_BODY}.]*)['"\`]`, 'g');
// Логгер модуля сигналов; нужен для диагностики какие символы были извлечены для retrieval-запроса.
const LOG = new SweepLogger('common:signals');

// Проверяет что код-символ может входить в тело идентификатора (латиница/кириллица/цифры/_/$); charCode быстрее regex в посимвольном цикле.
function isIdentBodyChar(code: number): boolean {
    return (code >= 48 && code <= 57)         // 0-9
        || (code >= 65 && code <= 90)         // A-Z
        || (code >= 97 && code <= 122)        // a-z
        || code === 95 || code === 36         // _ $
        || (code >= 0x0410 && code <= 0x044F) // А-я
        || code === 0x0401 || code === 0x0451; // Ё ё
}

// Проверяет что код-символ — цифра; нужен чтобы отсечь ведущие цифры (идентификатор не начинается с цифры).
function isDigitCode(code: number): boolean {
    return code >= 48 && code <= 57;
}

/**
 * Извлекает идентификатор непосредственно у курсора, чтобы retrieval-запрос начинался
 * с самого точного сигнала — того символа, который пользователь сейчас редактирует.
 */
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
    // Идентификатор не может начинаться с цифры: отсекаем ведущие цифры, иначе число/суффикс попадёт в сигнал.
    while (start < end && isDigitCode(text.charCodeAt(start))) {
        start++;
    }
    const symbol = text.slice(start, end);
    if (process.env.NODE_ENV === 'development') {
        LOG.debug('symbol at cursor extracted', { symbol, cursorOffset: offset });
    }
    return symbol;
}

/**
 * Извлекает импортируемые имена из окна редактора, чтобы retrieval нашёл файлы
 * с определениями импортированных зависимостей — они часто содержат нужный контекст.
 */
export function importedSymbols(text: string): string[] {
    const out = new Set<string>();
    const src = normalizeCrlf(text);
    for (let m = NAMED_IMPORT_RE.exec(src); m; m = NAMED_IMPORT_RE.exec(src)) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(AS_SPLIT_RE).pop()?.trim();
            if (name && IDENT_AT.test(name)) {
                out.add(name);
            }
        }
    }
    for (let m = DEFAULT_IMPORT_RE.exec(src); m; m = DEFAULT_IMPORT_RE.exec(src)) {
        out.add(m[1]);
    }
    for (let m = REQUIRE_RE.exec(src); m; m = REQUIRE_RE.exec(src)) {
        out.add(m[1]);
    }
    const symbols = [...out];
    if (process.env.NODE_ENV === 'development') {
        LOG.debug('imported symbols extracted', { count: symbols.length, symbols });
    }
    return symbols;
}

/**
 * Извлекает имена объявленных типов из окна редактора, чтобы retrieval нашёл
 * файлы с реализациями или расширениями этих типов — они релевантны при рефакторинге типов.
 */
export function declaredTypeNames(text: string): string[] {
    const out = new Set<string>();
    const src = normalizeCrlf(text);
    for (let m = DECLARED_TYPE_RE.exec(src); m; m = DECLARED_TYPE_RE.exec(src)) {
        out.add(m[1]);
    }
    const names = [...out];
    if (process.env.NODE_ENV === 'development') {
        LOG.debug('declared type names extracted', { count: names.length, names });
    }
    return names;
}

/**
 * Извлекает названия тестов из окна редактора, потому что они часто описывают конкретные
 * поведения и помогают retrieval найти связанные файлы при отладке тестов.
 */
export function testNames(text: string): string[] {
    const out = new Set<string>();
    const src = normalizeCrlf(text);
    for (let m = TEST_NAME_RE.exec(src); m; m = TEST_NAME_RE.exec(src)) {
        out.add(m[1].trim());
    }
    const names = [...out];
    if (process.env.NODE_ENV === 'development') {
        LOG.debug('test names extracted', { count: names.length, names });
    }
    return names;
}

/**
 * Извлекает идентификаторы из текста диагностических сообщений, чтобы retrieval
 * мог найти файлы с определениями символов упомянутых в ошибках компилятора.
 */
export function diagnosticSymbols(diagnostics: DiagnosticDTO[] | undefined): string[] {
    const out = new Set<string>();
    for (const d of diagnostics ?? []) {
        for (let m = DIAGNOSTIC_QUOTED_RE.exec(d.message); m; m = DIAGNOSTIC_QUOTED_RE.exec(d.message)) {
            const value = m[1];
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

/**
 * Извлекает идентификаторы которые появились или исчезли в диффах истории правок;
 * это самый точный сигнал переименования — именно то что пользователь только что изменил.
 */
export function renamedSymbols(recentEdits: RecentEdit[]): string[] {
    const added = new Set<string>();
    const removed = new Set<string>();
    for (const edit of recentEdits) {
        for (const line of splitLines(edit.unifiedDiff)) {
            if (line.startsWith('+') && !line.startsWith('+++')) {
                IDENT.lastIndex = 1;
                for (let m = IDENT.exec(line); m; m = IDENT.exec(line)) {
                    added.add(m[0]);
                }
            } else if (line.startsWith('-') && !line.startsWith('---')) {
                IDENT.lastIndex = 1;
                for (let m = IDENT.exec(line); m; m = IDENT.exec(line)) {
                    removed.add(m[0]);
                }
            }
        }
    }
    const changed = new Set<string>();
    for (const id of added) {
        if (!removed.has(id)) {
            changed.add(id);
        }
    }
    for (const id of removed) {
        if (!added.has(id)) {
            changed.add(id);
        }
    }
    const symbols = [...changed];
    if (process.env.NODE_ENV === 'development') {
        LOG.debug('renamed symbols extracted from recent edits', { count: symbols.length, symbols });
    }
    return symbols;
}

/**
 * Возвращает хвост unified-диффов истории правок как строку для вставки в retrieval-запрос;
 * хвост содержит самые свежие изменения, которые лучше всего описывают намерение пользователя.
 */
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
