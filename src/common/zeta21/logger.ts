// Уровни логирования zeta21-пайплайна; совпадают со Sweep чтобы диагностика разных NES-веток читалась одинаково.
export type ZetaLogLevel = 'debug' | 'info' | 'warn' | 'error';

// Произвольные метаданные записи лога; позволяют печатать структурированный контекст без ручной сериализации строк.
export type ZetaLogMeta = Record<string, unknown>;

/**
 * Единый логгер zeta21-пайплайна; держит формат совместимым со Sweep чтобы сравнивать два NES-стека в одних логах.
 */
export class ZetaLogger {
    // Идентификатор слоя или компонента; префикс нужен чтобы фильтровать записи по источнику.
    private readonly scope: string;

    /** Создаёт логгер для одного компонента zeta21, чтобы его сообщения шли с предсказуемым scope. */
    constructor(scope = 'zeta21') {
        this.scope = scope;
    }

    /** Создаёт дочерний логгер, когда один компонент хочет выделить внутренний подпроцесс отдельным scope. */
    child(scope: string): ZetaLogger {
        return new ZetaLogger(`${this.scope}:${scope}`);
    }

    /** Печатает низкоуровневые детали потока управления и данных для точечной трассировки пайплайна. */
    debug(message: string, meta?: ZetaLogMeta): void {
        this.write('debug', message, meta);
    }

    /** Печатает нормальные события жизненного цикла: trigger, prompt build, completion и parse. */
    info(message: string, meta?: ZetaLogMeta): void {
        this.write('info', message, meta);
    }

    /** Печатает восстанавливаемые проблемы, которые не должны ломать подсказку, но важны для диагностики деградации. */
    warn(message: string, meta?: ZetaLogMeta): void {
        this.write('warn', message, meta);
    }

    /** Печатает неожиданные сбои перед тем как пайплайн деградирует в пустой ответ. */
    error(message: string, meta?: ZetaLogMeta): void {
        this.write('error', message, meta);
    }

    /** Печатает полный промпт отдельной записью, чтобы training-format можно было быстро скопировать и проверить. */
    prompt(label: string, prompt: string, meta?: ZetaLogMeta): void {
        this.write('info', `${label} prompt`, { ...meta, promptChars: prompt.length });
        if (process.env.NODE_ENV === 'development') {
            console.info(`[Zeta:${this.scope}] ${label} prompt text:\n${prompt}`);
        }
    }

    /** Форматирует одну запись и отправляет её в подходящий console-метод, сохраняя payload раскрываемым в DevTools. */
    private write(level: ZetaLogLevel, message: string, meta?: ZetaLogMeta): void {
        const prefix = `[Zeta:${this.scope}] ${message}`;
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

function hasEnumerableKey(meta: ZetaLogMeta): boolean {
    for (const key in meta) {
        if (Object.getOwnPropertyDescriptor(meta, key) !== undefined) {
            return true;
        }
    }
    return false;
}
