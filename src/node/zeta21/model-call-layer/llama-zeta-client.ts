import { ZetaLogger } from '../../../common/zeta21/logger';

const LOG = new ZetaLogger('node:model-call:llama-zeta-client');
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// Параметры одного completion-запроса к llama.cpp; собираются из BuiltZetaPrompt в Zeta backend service.
export interface LlamaZetaCompletionRequest {
    baseUrl: string;
    model: string;
    prompt: string;
    stop: string[];
    maxTokens: number;
    temperature: number;
    cachePrompt: boolean;
    seed: number;
    signal?: AbortSignal;
}

// Минимальная форма ответа llama.cpp `/completions`; остальные поля zeta21-пайплайну не нужны.
interface CompletionResponse {
    choices?: Array<{ text?: string; finish_reason?: string }>;
}

/** Отправляет raw completion-запросы к llama.cpp и логирует время ответа и текст промпта для диагностики Zeta. */
export class LlamaZetaClient {
    /** Отправляет один синхронный completion-запрос и возвращает raw text ответа модели. */
    async complete(request: LlamaZetaCompletionRequest): Promise<string> {
        const startedAt = Date.now();
        const body = {
            model: request.model,
            prompt: request.prompt,
            max_tokens: request.maxTokens,
            temperature: request.temperature,
            stop: request.stop,
            cache_prompt: request.cachePrompt,
            seed: request.seed,
            stream: false,
        };
        LOG.prompt('model-call', request.prompt, {
            baseUrl: request.baseUrl,
            model: request.model,
            maxTokens: request.maxTokens,
            temperature: request.temperature,
            stop: request.stop,
            cachePrompt: request.cachePrompt,
            seed: request.seed,
        });
        const baseUrl = request.baseUrl.endsWith('/') ? request.baseUrl.slice(0, -1) : request.baseUrl;
        const response = await this.post(baseUrl, JSON.stringify(body), request.signal, true);
        const json = (await response.json()) as CompletionResponse;
        const text = json.choices?.[0]?.text ?? '';
        LOG.info('Zeta llama.cpp completion returned', { durationMs: Date.now() - startedAt, rawChars: text.length });
        if (process.env.NODE_ENV === 'development') {
            LOG.debug('Zeta llama.cpp raw response text', { text });
        }
        return text;
    }

    /** Отправляет POST к `/completions` и выполняет один retry при 503, если локальный llama.cpp временно занят. */
    private async post(baseUrl: string, bodyText: string, signal: AbortSignal | undefined, retry503: boolean): Promise<Response> {
        const response = await fetch(`${baseUrl}/completions`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: bodyText,
            signal,
        });
        if (response.status === 503 && retry503) {
            const retryMs = retryAfterMs(response);
            LOG.warn('Zeta llama.cpp server busy, retrying once', { retryMs });
            await wait(retryMs, signal);
            return this.post(baseUrl, bodyText, signal, false);
        }
        if (!response.ok) {
            LOG.error('Zeta completion request failed', { status: response.status, statusText: response.statusText });
            throw new Error(`Zeta completion request failed: ${response.status} ${response.statusText}`);
        }
        return response;
    }
}

function retryAfterMs(response: Response): number {
    const header = response.headers.get('retry-after');
    if (!header) {
        return 200;
    }
    const seconds = Number(header);
    return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : 200;
}

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

function abortError(): Error {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}
