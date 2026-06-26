import * as fs from 'node:fs';
import * as path from 'node:path';

// Локальный Qwen2.5-Coder tokenizer поставляется с плагином, чтобы token-aware budget работал offline.
const DEFAULT_QWEN_TOKENIZER = 'qwen2.5-coder';

/**
 * Интерфейс синхронного счётчика токенов; разделяет загрузку (async ensureReady)
 * и подсчёт (sync count) чтобы не ждать WASM в горячем пути сборки промпта.
 */
export interface TokenCounter {
    ensureReady(): Promise<void>;
    count(text: string): number;
    readonly mode: 'tokenizer' | 'char-fallback';
}

// Минимальная форма AutoTokenizer из transformers.js; нужна для безопасного доступа через dynamic import, который возвращает unknown.
type AutoTokenizerFactory = {
    from_pretrained(model: string): Promise<unknown>;
};

// Форма модуля @xenova/transformers; поле опционально потому что dynamic import может вернуть иную структуру при сбое или устаревшей версии.
type TransformersModule = {
    AutoTokenizer?: AutoTokenizerFactory;
    env?: TransformersEnv;
};

// Минимальная форма transformers.js env; нужна чтобы запретить сеть и указать bundled tokenizer root.
type TransformersEnv = {
    allowRemoteModels?: boolean;
    allowLocalModels?: boolean;
    localModelPath?: string;
};

// Форма BatchEncoding из Hugging Face transformers; input_ids содержит токены, остальные поля нас не интересуют.
type EncodedWithIds = {
    input_ids?: unknown;
};

/**
 * Ленивая обёртка над Qwen2.5-токенайзером для точного подсчёта токенов в бюджете промпта;
 * при сбое загрузки деградирует до char-estimate чтобы не блокировать подсказку.
 */
export class QwenTokenCounter implements TokenCounter {
    // Токенайзер хранится как unknown потому что dynamic import типизируется по минимуму; null = ещё не загружен.
    private tokenizer: unknown = null;
    // Промис загрузки кэшируется чтобы повторные вызовы ensureReady не запускали новый import.
    private ready: Promise<void> | null = null;
    // Флаг fallback выставляется при любом сбое загрузки; после этого count всегда использует char-оценку.
    private fallback = false;

    constructor(private readonly model = process.env.SC_QWEN_TOKENIZER || DEFAULT_QWEN_TOKENIZER) {}

    // Режим публикуется наружу чтобы trimmer мог залогировать, работает ли он с точными токенами или грубой оценкой.
    get mode(): 'tokenizer' | 'char-fallback' {
        return this.fallback || this.tokenizer === null ? 'char-fallback' : 'tokenizer';
    }

    /**
     * Запускает загрузку WASM-токенайзера один раз и кэширует промис;
     * повторные вызовы возвращают тот же промис без повторной загрузки.
     */
    async ensureReady(): Promise<void> {
        if (this.ready !== null) {
            return this.ready;
        }
        this.ready = this.load();
        return this.ready;
    }

    /**
     * Синхронно считает токены через загруженный токенайзер или деградирует в char-оценку;
     * синхронность обязательна чтобы trimmer не превращался в async-цепочку на каждом фрагменте.
     */
    count(text: string): number {
        if (!text) {
            return 0;
        }
        if (this.tokenizer === null) {
            return charTokenEstimate(text);
        }
        try {
            const encoded = encodeWithTokenizer(this.tokenizer, text);
            return encoded >= 0 ? encoded : charTokenEstimate(text);
        } catch {
            return charTokenEstimate(text);
        }
    }

    /** Загружает tokenizer только из bundled resources; при любой ошибке включает char fallback. */
    private async load(): Promise<void> {
        try {
            const mod = await import('@xenova/transformers') as TransformersModule;
            if (mod.env) {
                configureTransformersEnv(mod.env);
            }
            if (!mod.AutoTokenizer) {
                this.fallback = true;
                return;
            }
            this.tokenizer = await mod.AutoTokenizer.from_pretrained(this.model);
        } catch {
            this.fallback = true;
        }
    }
}

/** Настраивает transformers.js на локальные модели, чтобы offline запуск не пытался идти в HF Hub. */
function configureTransformersEnv(env: TransformersEnv): void {
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = resolveTokenizerRoot();
}

/** Находит tokenizer root и для production lib/, и для test lib-test/ сборки. */
function resolveTokenizerRoot(): string {
    const bundled = path.resolve(__dirname, '../../../resources/tokenizers');
    if (fs.existsSync(bundled)) {
        return bundled;
    }
    const workspace = path.resolve(process.cwd(), 'resources/tokenizers');
    return fs.existsSync(workspace) ? workspace : bundled;
}

/**
 * Грубая оценка числа токенов через длину строки: один токен ≈ 4 символа для кода на Latin;
 * используется как fallback когда токенайзер не загрузился.
 */
export function charTokenEstimate(text: string): number {
    if (!text) {
        return 0;
    }
    return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Диспатч вызова encode через разные формы токенайзера; transformers.js менял API
 * между версиями — проверяем метод .encode и callable-форму для совместимости.
 */
function encodeWithTokenizer(tokenizer: unknown, text: string): number {
    if (hasEncode(tokenizer)) {
        return encodedLength(tokenizer.encode(text));
    }
    if (typeof tokenizer === 'function') {
        return encodedLength((tokenizer as (input: string) => unknown)(text));
    }
    return -1;
}

// Type guard для объектов с методом .encode; нужен потому что токенайзер приходит как unknown из dynamic import.
function hasEncode(value: unknown): value is { encode(text: string): unknown } {
    return typeof value === 'object' && value !== null && typeof (value as { encode?: unknown }).encode === 'function';
}

/**
 * Извлекает число токенов из разных форм ответа encode; API Hugging Face возвращает
 * Array, TypedArray или BatchEncoding с input_ids в зависимости от версии пакета.
 */
function encodedLength(value: unknown): number {
    if (Array.isArray(value)) {
        return value.length;
    }
    if (ArrayBuffer.isView(value)) {
        return viewLength(value);
    }
    if (isEncodedWithIds(value)) {
        return encodedLength(value.input_ids);
    }
    return -1;
}

// Type guard для BatchEncoding; Hugging Face токенайзеры возвращают объект с полем input_ids вместо чистого массива.
function isEncodedWithIds(value: unknown): value is EncodedWithIds {
    return typeof value === 'object' && value !== null && 'input_ids' in value;
}

// Безопасный доступ к длине TypedArray/DataView; ArrayBufferView не гарантирует .length, у DataView его нет — берём byteLength.
function viewLength(value: ArrayBufferView): number {
    return 'length' in value && typeof value.length === 'number' ? value.length : value.byteLength;
}
