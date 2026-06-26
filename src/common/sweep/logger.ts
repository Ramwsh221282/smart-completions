// Уровни логирования Sweep-пайплайна; debug для трассировки, info для жизненного цикла, warn/error для проблем.
export type SweepLogLevel = 'debug' | 'info' | 'warn' | 'error';

// Произвольные метаданные записи лога; позволяют передавать структурированный контекст без форматирования строк.
export type SweepLogMeta = Record<string, unknown>;

/**
 * Единый логгер Sweep-пайплайна; намеренно печатает полные промпты потому что плагин локальный
 * и инспекция промптов обязательна для диагностики регрессий training-формата.
 */
export class SweepLogger {
    // Строковый идентификатор слоя или компонента; вставляется в каждую запись чтобы фильтровать логи по источнику.
    private readonly scope: string;

    /**
     * Создаёт логгер с именем scope; каждый Sweep-компонент создаёт свой экземпляр
     * чтобы логи было легко фильтровать по слою в консоли.
     */
    constructor(scope = 'sweep') {
        this.scope = scope;
    }

    /**
     * Создаёт дочерний логгер с вложенным именем scope; нужен когда один компонент
     * хочет выделить внутренний подпроцесс без создания нового экземпляра класса.
     */
    child(scope: string): SweepLogger {
        return new SweepLogger(`${this.scope}:${scope}`);
    }

    /**
     * Печатает низкоуровневые детали потока управления и данных; нужен при трассировке
     * конкретного шага пайплайна без засорения информационного уровня.
     */
    debug(message: string, meta?: SweepLogMeta): void {
        this.write('debug', message, meta);
    }

    /**
     * Печатает нормальные события жизненного цикла: триггер, построение промпта, завершение вызова;
     * именно этот уровень читают при диагностике без включения debug-режима.
     */
    info(message: string, meta?: SweepLogMeta): void {
        this.write('info', message, meta);
    }

    /**
     * Печатает восстанавливаемые проблемы, которые не ломают предсказание но сигнализируют
     * о деградации: недоступный источник контекста, занятый сервер и т.д.
     */
    warn(message: string, meta?: SweepLogMeta): void {
        this.write('warn', message, meta);
    }

    /**
     * Печатает неожиданные сбои перед тем как они будут проброшены или превращены
     * в пустое предсказание; нужен чтобы ошибки не терялись молча.
     */
    error(message: string, meta?: SweepLogMeta): void {
        this.write('error', message, meta);
    }

    /**
     * Печатает полный текст промпта отдельной строкой чтобы его было легко скопировать и проверить;
     * используется в prompt-creating и model-call слоях для диагностики training-format регрессий.
     */
    prompt(label: string, prompt: string, meta?: SweepLogMeta): void {
        this.write('info', `${label} prompt`, { ...meta, promptChars: prompt.length });
        console.info(`[Sweep:${this.scope}] ${label} prompt text:\n${prompt}`);
    }

    /**
     * Форматирует и отправляет одну запись в ближайший доступный console-метод;
     * payload передаётся отдельным аргументом чтобы DevTools раскрывал объекты интерактивно.
     */
    private write(level: SweepLogLevel, message: string, meta?: SweepLogMeta): void {
        const prefix = `[Sweep:${this.scope}] ${message}`;
        const payload = meta && hasEnumerableKey(meta) ? meta : undefined;
        switch (level) {
            case 'debug':
                console.debug(prefix, payload ?? '');
                break;
            case 'warn':
                console.warn(prefix, payload ?? '');
                break;
            case 'error':
                console.error(prefix, payload ?? '');
                break;
            default:
                console.info(prefix, payload ?? '');
        }
    }
}

function hasEnumerableKey(meta: SweepLogMeta): boolean {
    for (const key in meta) {
        if (Object.getOwnPropertyDescriptor(meta, key) !== undefined) {
            return true;
        }
    }
    return false;
}
