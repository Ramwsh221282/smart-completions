export interface LlamaNesCompletionRequest {
    baseUrl: string;
    model: string;
    prompt: string;
    stop: string[];
    maxTokens: number;
    temperature: number;
    signal?: AbortSignal;
}

interface CompletionResponse {
    choices?: Array<{ text?: string; finish_reason?: string }>;
}

export class LlamaNesClient {
    async complete(request: LlamaNesCompletionRequest): Promise<string> {
        const body = {
            model: request.model,
            prompt: request.prompt,
            max_tokens: request.maxTokens,
            temperature: request.temperature,
            stop: request.stop,
            stream: false,
        };
        const response = await this.post(request.baseUrl, body, request.signal, true);
        const json = (await response.json()) as CompletionResponse;
        return json.choices?.[0]?.text ?? '';
    }

    private async post(baseUrl: string, body: object, signal: AbortSignal | undefined, retry503: boolean): Promise<Response> {
        const response = await fetch(`${baseUrl.replace(/\/$/, '')}/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
        });
        if (response.status === 503 && retry503) {
            await wait(retryAfterMs(response), signal);
            return this.post(baseUrl, body, signal, false);
        }
        if (!response.ok) {
            throw new Error(`NES completion request failed: ${response.status} ${response.statusText}`);
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
    return new Promise((resolve, reject) => {
        const handle = setTimeout(resolve, ms);
        const onAbort = () => {
            clearTimeout(handle);
            reject(abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function abortError(): Error {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}
