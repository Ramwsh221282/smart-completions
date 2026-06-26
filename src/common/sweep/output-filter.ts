import { splitLines } from '../text/crlf';
import { SweepLogger } from './logger';

// Логгер модуля фильтрации вывода; нужен для диагностики сколько строк было отобрано из Output-канала.
const LOG = new SweepLogger('common:output-filter');

// Параметры фильтрации; вынесены в интерфейс чтобы тесты могли подставлять малые значения без изменения логики.
export interface OutputFilterOptions {
    maxScanLines: number;
    contextBefore: number;
    contextAfter: number;
    maxFrames: number;
    maxLines: number;
}

// Разумные дефолты для продакшена: достаточно строк для диагностики но не настолько много чтобы перегрузить промпт.
export const DEFAULT_OUTPUT_FILTER: OutputFilterOptions = {
    maxScanLines: 150,
    contextBefore: 1,
    contextAfter: 2,
    maxFrames: 10,
    maxLines: 60,
};

// Удаляет ANSI-escape коды цветового оформления которые не несут смысловой нагрузки для модели.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
// Удаляет ведущие временные метки которые занимают место в промпте но не нужны модели.
const LEADING_TIMESTAMP =
    /^\s*(?:\[\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\]|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?Z?)\s*/;
// Заменяет секреты заглушкой чтобы токены и пароли не попадали в Sweep-промпт.
const SECRET = /\b(token|password|passwd|secret|api[_-]?key|authorization|bearer)\b\s*[:=]\s*\S+/gi;
// Маркер строки с ошибкой; нужен для отбора строк которые содержат диагностически значимую информацию.
const ERROR_LINE = /\b(error|err|fail(?:ed|ure)?|exception|panic|fatal|traceback)\b/i;
// Маркер ссылки на файл с номером строки; нужен для включения строк позиционирующих ошибку в коде.
const FILE_LINE_COL = /[-\w./\\]+\.[A-Za-z]+:\d+(?::\d+)?/;
// Маркер фрейма стектрейса; нужен для включения нескольких верхних фреймов как контекста ошибки.
const STACK_FRAME = /^\s*(at\s+|File\s+"|\s+#\d+\s|>>>\s)/;

/**
 * Убирает ANSI, временные метки и секреты из одной строки вывода перед её включением в Sweep-промпт;
 * очистка необходима чтобы шум не занимал бюджет токенов и не галлюцинировал в модели.
 */
function stripNoise(line: string): string {
    return line.replace(ANSI, '').replace(LEADING_TIMESTAMP, '').replace(SECRET, '$1=<redacted>').trimEnd();
}

/**
 * Отбирает строки с ошибками, файловыми ссылками и фреймами стектрейса вместе с контекстом вокруг них;
 * нужен чтобы output/ псевдофайл содержал только диагностически полезную информацию без лишнего шума.
 */
export function extractRelevantOutput(rawText: string, options: OutputFilterOptions = DEFAULT_OUTPUT_FILTER): string {
    const split = splitLines(rawText);
    const scanStart = Math.max(0, split.length - Math.max(1, options.maxScanLines));
    const lines = new Array<string>(split.length - scanStart);
    for (let i = scanStart; i < split.length; i++) {
        lines[i - scanStart] = stripNoise(split[i]);
    }

    const keep = new Array<boolean>(lines.length).fill(false);
    let frames = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) {
            continue;
        }
        const isError = ERROR_LINE.test(line);
        const isFileRef = FILE_LINE_COL.test(line);
        const isFrame = STACK_FRAME.test(line);
        if (isError || isFileRef) {
            const from = Math.max(0, i - options.contextBefore);
            const to = Math.min(lines.length - 1, i + options.contextAfter);
            for (let j = from; j <= to; j++) {
                if (lines[j]) {
                    keep[j] = true;
                }
            }
        } else if (isFrame && frames < options.maxFrames) {
            keep[i] = true;
            frames++;
        }
    }

    const selected: string[] = [];
    for (let i = 0; i < keep.length && selected.length < options.maxLines; i++) {
        if (keep[i]) {
            selected.push(lines[i]);
        }
    }

    if (selected.length === 0) {
        LOG.info('Sweep output filter found no relevant lines', { scanned: lines.length });
        return '';
    }

    const snippet = selected.join('\n');
    LOG.info('Sweep output snippet extracted', { scanned: lines.length, selected: selected.length, chars: snippet.length });
    if (process.env.NODE_ENV === 'development') {
        LOG.debug('Sweep output snippet text', { snippet });
    }
    return snippet;
}
