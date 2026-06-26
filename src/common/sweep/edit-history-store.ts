import { RecentEdit } from '../edit-history-types';
import { SweepLogger } from './logger';
import { splitLines } from '../text/crlf';

// Кольцевой буфер ограничен 40 записями, чтобы история не росла бесконечно и не вытесняла полезный контекст из промпта.
export const MAX_HISTORY = 40;
// Пауза перед записью диффа: бурст нажатий схлопывается в один diff вместо вычисления на каждый keystroke. Корректность чтения гарантирует flush-on-read.
export const RECORD_DEBOUNCE_MS = 250;
// Логгер ядра истории правок; нужен для диагностики того, какие диффы попадают в Sweep-контекст.
const LOG = new SweepLogger('common:edit-history-store');

// Минимальная модель документа без зависимости от Monaco; позволяет тестировать ядро истории без браузерного окружения.
export interface EditHistoryModel {
    uri: string;
    getValue(): string;
}

/**
 * Monaco-free ядро истории правок Sweep.
 *
 * Хранит кольцевой буфер unified diff-ов (обязательный сигнал NES) и снимок документа до последней
 * правки для original/-блока. Запись диффа отложена debounce-таймером (бурст keystroke → один diff),
 * а чтение всегда материализует отложенную правку (flush-on-read), исключая гонку с триггером.
 */
export class EditHistoryStore {
    // Последний записанный текст каждой модели; база для построения unified diff при следующей правке.
    private readonly previousText = new Map<string, string>();
    // Снимок документа ДО последней правки; нужен для заполнения блока original/ в Sweep-промпте.
    private readonly preEditText = new Map<string, string>();
    // Хронологический буфер диффов; Sweep использует его как обязательный сигнал для предсказания правки.
    private readonly history: RecentEdit[] = [];
    // Отложенные таймеры записи по uri; бурст keystroke перезапускает таймер, схлопываясь в один diff.
    private readonly pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    // Активные модели по uri; нужны чтобы flush мог вычислить diff отложенной правки по требованию.
    private readonly trackedModels = new Map<string, EditHistoryModel>();

    // debounceMs параметризован, чтобы тесты могли управлять паузой; по умолчанию — общий backstop-интервал.
    constructor(private readonly debounceMs: number = RECORD_DEBOUNCE_MS) {}

    /**
     * Начинает следить за моделью и фиксирует её текущий текст как базу диффа; идемпотентен,
     * чтобы повторный track того же uri не сбрасывал уже накопленную базу.
     */
    track(model: EditHistoryModel): void {
        if (this.trackedModels.has(model.uri)) {
            return;
        }
        this.previousText.set(model.uri, model.getValue());
        this.trackedModels.set(model.uri, model);
        if (process.env.NODE_ENV === 'development') {
            LOG.debug('Sweep model edit history tracking enabled', { uri: model.uri });
        }
    }

    /**
     * Снимает модель с трекинга, предварительно материализуя её отложенную правку,
     * чтобы при закрытии файла не потерять последний бурст из истории.
     */
    untrack(uri: string): void {
        this.flush(uri);
        const timer = this.pendingTimers.get(uri);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.pendingTimers.delete(uri);
        }
        this.previousText.delete(uri);
        this.preEditText.delete(uri);
        this.trackedModels.delete(uri);
        if (process.env.NODE_ENV === 'development') {
            LOG.debug('Sweep model edit history removed', { uri });
        }
    }

    /**
     * Перезапускает debounce-таймер записи для модели; пока пользователь печатает, diff не вычисляется,
     * а бурст нажатий схлопывается в одну запись по истечении паузы.
     */
    scheduleRecord(uri: string): void {
        const existing = this.pendingTimers.get(uri);
        if (existing !== undefined) {
            clearTimeout(existing);
        }
        this.pendingTimers.set(uri, setTimeout(() => this.flush(uri), this.debounceMs));
    }

    /**
     * Возвращает свежие диффы; сперва материализует все отложенные правки, чтобы триггер
     * всегда видел самый свежий edit-сигнал. Пустой список означает, что Sweep не запускается.
     */
    getRecentEdits(limit = 8): RecentEdit[] {
        this.flushAll();
        const edits = this.history.slice(-limit);
        if (process.env.NODE_ENV === 'development') {
            LOG.debug('Sweep recent edits requested', { requestedLimit: limit, returned: edits.length });
        }
        return edits;
    }

    /**
     * Возвращает срез документа из состояния ДО последней правки для блока original/;
     * сперва материализует отложенную правку этого файла, чтобы снимок отражал состояние до бурста.
     */
    getWindowBeforeLastEdit(uri: string, startLine0: number, endLine0: number): string | undefined {
        this.flush(uri);
        const before = this.preEditText.get(uri);
        if (before === undefined) {
            if (process.env.NODE_ENV === 'development') {
                LOG.debug('Sweep original window snapshot missing', { uri, startLine0, endLine0 });
            }
            return undefined;
        }
        const lines = splitLines(before);
        const window = joinLineRange(lines, Math.max(0, startLine0), Math.max(0, endLine0) + 1);
        if (process.env.NODE_ENV === 'development') {
            LOG.debug('Sweep original window snapshot returned', { uri, startLine0, endLine0, chars: window.length });
        }
        return window;
    }

    /**
     * Освобождает таймеры и все накопленные данные; нужен чтобы ядро не удерживало память
     * и не оставляло висящих таймеров после остановки рекордера.
     */
    dispose(): void {
        for (const timer of this.pendingTimers.values()) {
            clearTimeout(timer);
        }
        this.pendingTimers.clear();
        this.trackedModels.clear();
        this.previousText.clear();
        this.preEditText.clear();
        this.history.length = 0;
    }

    /**
     * Принудительно вычисляет отложенную правку модели; no-op если для uri нет ожидающего таймера.
     * Используется flush-on-read, чтобы чтение всегда видело актуальную историю без гонки таймеров.
     */
    private flush(uri: string): void {
        const timer = this.pendingTimers.get(uri);
        if (timer === undefined) {
            return;
        }
        clearTimeout(timer);
        this.pendingTimers.delete(uri);
        const model = this.trackedModels.get(uri);
        if (model) {
            this.recordChange(model);
        }
    }

    /**
     * Материализует все отложенные правки; нужен в getRecentEdits, т.к. история глобальна
     * и триггер должен видеть свежие диффы из любого редактируемого файла.
     */
    private flushAll(): void {
        if (this.pendingTimers.size === 0) {
            return;
        }
        for (const uri of [...this.pendingTimers.keys()]) {
            this.flush(uri);
        }
    }

    /**
     * Фиксирует одно изменение модели: строит компактный unified diff от previousText к текущему тексту
     * и сохраняет снимок до правки для original/-блока. Пустой diff или отсутствие изменений — не пишется.
     */
    private recordChange(model: EditHistoryModel): void {
        const uri = model.uri;
        const before = this.previousText.get(uri) ?? '';
        const after = model.getValue();
        this.previousText.set(uri, after);
        if (before === after) {
            return;
        }
        const unifiedDiff = formatSweepUnifiedDiff(uri, before, after);
        if (!unifiedDiff) {
            return;
        }
        this.preEditText.set(uri, before);
        this.history.push({ uri, unifiedDiff, timestamp: Date.now() });
        const excess = this.history.length - MAX_HISTORY;
        if (excess > 0) {
            this.history.splice(0, excess);
        }
        LOG.info('Sweep recent edit recorded', { uri, diffChars: unifiedDiff.length, historySize: this.history.length });
        if (process.env.NODE_ENV === 'development') {
            LOG.debug('Sweep recent edit diff text', { unifiedDiff });
        }
    }
}

function joinLineRange(lines: string[], start: number, endExclusive: number): string {
    const end = Math.min(lines.length, endExclusive);
    if (start >= end) {
        return '';
    }
    let out = lines[start];
    for (let i = start + 1; i < end; i++) {
        out += `\n${lines[i]}`;
    }
    return out;
}

/**
 * Строит минимальный unified diff между двумя версиями файла для истории правок;
 * формат заточен под Sweep-промпт (используется только ядром истории).
 */
export function formatSweepUnifiedDiff(uri: string, before: string, after: string): string {
    const oldLines = splitLines(before);
    const newLines = splitLines(after);
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
        prefix++;
    }
    let suffix = 0;
    while (
        suffix < oldLines.length - prefix &&
        suffix < newLines.length - prefix &&
        oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
        suffix++;
    }
    if (prefix === oldLines.length && prefix === newLines.length) {
        return '';
    }
    const oldEnd = oldLines.length - suffix;
    const newEnd = newLines.length - suffix;
    const parts = [
        `--- ${uri}`,
        `+++ ${uri}`,
        `@@ -${prefix + 1},${oldEnd - prefix} +${prefix + 1},${newEnd - prefix} @@`,
    ];
    for (let i = prefix; i < oldEnd; i++) {
        parts.push(`-${oldLines[i]}`);
    }
    for (let i = prefix; i < newEnd; i++) {
        parts.push(`+${newLines[i]}`);
    }
    return parts.join('\n');
}
