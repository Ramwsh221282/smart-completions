// Способ pooling должен совпадать с GGUF-моделью, иначе retrieval будет деградировать даже при валидном ответе /embeddings.
export const FimPooling = { Mean: 'mean', LastToken: 'last-token' } as const;
export type FimPooling = typeof FimPooling[keyof typeof FimPooling];

// Профиль описывает всё, что нужно FIM embedding-space для корректного query/document кодирования.
export interface FimEmbedderProfile {
    id: string;
    llamaModel: string;
    pooling: FimPooling;
    dimension: number;
    queryInstruction: string | null;
    documentInstruction: string | null;
    matryoshkaDim: number | null;
}

export function buildQueryInput(profile: FimEmbedderProfile, text: string): string {
    return profile.queryInstruction ? `${profile.queryInstruction}${text}` : text;
}

export function buildDocumentInput(profile: FimEmbedderProfile, text: string): string {
    return profile.documentInstruction ? `${profile.documentInstruction}${text}` : text;
}

export function applyMatryoshka(profile: FimEmbedderProfile, vector: Float32Array): Float32Array {
    if (profile.matryoshkaDim === null || profile.matryoshkaDim >= vector.length) {
        return vector;
    }
    return vector.subarray(0, profile.matryoshkaDim);
}
