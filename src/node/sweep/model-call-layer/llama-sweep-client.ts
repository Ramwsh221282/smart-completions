import { SweepLogger } from '../../../common/sweep/logger';

// Логгер клиента llama.cpp; нужен для печати полного промпта и времени ответа при каждом вызове модели.
const LOG = new SweepLogger('node:model-call:llama-sweep-client');
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// Параметры одного completion-запроса к llama.cpp; собирается из BuiltSweepPrompt в SweepBackendService.
export interface LlamaSweepCompletionRequest {
    baseUrl: string;
    model: string;
    prompt: string;
    stop: string[];
    maxTokens: number;
    temperature: number;
    cachePrompt?: boolean;
    seed?: number;
    signal?: AbortSignal;
}

// Минимальная форма ответа llama.cpp /completions; остальные поля нас не интересуют.
interface CompletionResponse {
    choices?: Array<{ text?: string; finish_reason?: string }>;
}

/** Отправляет raw completion-запросы к llama.cpp и логирует полный промпт и ответ для диагностики Sweep-предсказаний. */
export class LlamaSweepClient {
    /**
     * Отправляет один синхронный (non-streaming) completion-запрос и возвращает текст ответа;
     * raw-режим обязателен для Sweep чтобы `<|file_sep|>` токены попали в модель буквально.
     */
    async complete(request: LlamaSweepCompletionRequest): Promise<string> {
        const startedAt = Date.now();
        const body = {
            model: request.model,
            prompt: request.prompt,
            max_tokens: request.maxTokens,
            temperature: request.temperature,
            stop: request.stop,
            cache_prompt: request.cachePrompt ?? true,
            seed: request.seed ?? 0,
            stream: false,
        };
        LOG.prompt('model-call', request.prompt, {
            baseUrl: request.baseUrl,
            model: request.model,
            maxTokens: request.maxTokens,
            temperature: request.temperature,
            stop: request.stop,
            cachePrompt: request.cachePrompt ?? true,
            seed: request.seed ?? 0,
        });
        const baseUrl = request.baseUrl.endsWith('/') ? request.baseUrl.slice(0, -1) : request.baseUrl;
        const bodyText = JSON.stringify(body);
        const response = await this.post(baseUrl, bodyText, request.signal, true);
        const json = (await response.json()) as CompletionResponse;
        const text = json.choices?.[0]?.text ?? '';
        LOG.info('Sweep llama.cpp completion returned', { durationMs: Date.now() - startedAt, rawChars: text.length });
        if (process.env.NODE_ENV === 'development') {
            LOG.debug('Sweep llama.cpp raw response text', { text });
        }
        return text;
    }

    /**
     * Отправляет POST к `/completions` и выполняет одну попытку повтора при 503;
     * повтор нужен потому что локальный llama.cpp может быть временно занят другим запросом.
     */
    private async post(baseUrl: string, bodyText: string, signal: AbortSignal | undefined, retry503: boolean): Promise<Response> {
        const response = await fetch(`${baseUrl}/completions`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: bodyText,
            signal,
        });
        if (response.status === 503 && retry503) {
            const retryMs = retryAfterMs(response);
            LOG.warn('Sweep llama.cpp server busy, retrying once', { retryMs });
            await wait(retryMs, signal);
            return this.post(baseUrl, bodyText, signal, false);
        }
        if (!response.ok) {
            LOG.error('Sweep completion request failed', { status: response.status, statusText: response.statusText });
            throw new Error(`Sweep completion request failed: ${response.status} ${response.statusText}`);
        }
        return response;
    }
}

/**
 * Читает Retry-After заголовок из 503-ответа llama.cpp и переводит в миллисекунды;
 * нужен чтобы повтор выждал именно столько сколько просит сервер а не фиксированное время.
 */
function retryAfterMs(response: Response): number {
    const header = response.headers.get('retry-after');
    if (!header) {
        return 200;
    }
    const seconds = Number(header);
    return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : 200;
}

/**
 * Ждёт заданное время оставаясь прерываемым через AbortSignal;
 * нужен чтобы отмена Sweep-запроса срабатывала даже во время паузы перед повтором 503.
 */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(abortError());
    }
    if (!signal) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    return new Promise((resolve, reject) => {
        const handle = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(handle);
            reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Создаёт AbortError с корректным name чтобы isAbortError в SweepBackendService
 * мог отличить отмену от настоящей сетевой ошибки и не пробрасывал её пользователю.
 */
function abortError(): Error {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}
