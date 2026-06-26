export type FimLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type FimLogMeta = Record<string, unknown>;

// FIM держит отдельный логгер, чтобы prompt/retrieval логи не смешивались с Sweep и Zeta потоками.
export class FimLogger {
    private readonly scope: string;

    constructor(scope = 'fim') {
        this.scope = scope;
    }

    child(scope: string): FimLogger {
        return new FimLogger(`${this.scope}:${scope}`);
    }

    debug(message: string, meta?: FimLogMeta): void {
        this.write('debug', message, meta);
    }

    info(message: string, meta?: FimLogMeta): void {
        this.write('info', message, meta);
    }

    warn(message: string, meta?: FimLogMeta): void {
        this.write('warn', message, meta);
    }

    error(message: string, meta?: FimLogMeta): void {
        this.write('error', message, meta);
    }

    prompt(label: string, prompt: string, meta?: FimLogMeta): void {
        this.write('info', `${label} prompt`, { ...meta, promptChars: prompt.length });
        console.info(`[Fim:${this.scope}] ${label} prompt text:\n${prompt}`);
    }

    private write(level: FimLogLevel, message: string, meta?: FimLogMeta): void {
        const prefix = `[Fim:${this.scope}] ${message}`;
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

function hasEnumerableKey(meta: FimLogMeta): boolean {
    for (const key in meta) {
        if (Object.getOwnPropertyDescriptor(meta, key) !== undefined) {
            return true;
        }
    }
    return false;
}
