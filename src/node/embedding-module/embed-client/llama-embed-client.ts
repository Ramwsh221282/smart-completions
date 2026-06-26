/**
 * OpenAI-совместимый клиент эмбеддингов к llama.cpp.
 * POST {baseUrl}/embeddings  body { model, input: string[] } → { data: [{ embedding, index }] }.
 * baseUrl хранится как задано пользователем, включая /v1 для серверов с таким префиксом API.
 */
export interface EmbedClientOptions {
    baseUrl: string;
    model: string;
}

/** Абстракция клиента эмбеддингов (для подмены дублёром в тестах). */
export interface EmbedClient {
    embed(inputs: string[], signal?: AbortSignal): Promise<number[][]>;
}

interface EmbeddingsResponse {
    data?: Array<{ embedding: number[]; index?: number }>;
}

export class LlamaEmbedClient implements EmbedClient {
    constructor(private options: EmbedClientOptions) {}

    setOptions(options: EmbedClientOptions): void {
        this.options = options;
    }

    async embed(inputs: string[], signal?: AbortSignal): Promise<number[][]> {
        if (inputs.length === 0) {
            return [];
        }
        const url = `${this.options.baseUrl.replace(/\/$/, '')}/embeddings`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: this.options.model, input: inputs }),
            signal,
        });
        if (!res.ok) {
            throw new Error(`embed request failed: ${res.status} ${res.statusText}`);
        }
        const json = (await res.json()) as EmbeddingsResponse;
        const data = json.data ?? [];
        return data
            .slice()
            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
            .map(d => d.embedding);
    }
}
