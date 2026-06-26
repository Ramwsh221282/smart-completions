import type { FimEmbedderProfile } from './fim-embedder';
import { FimPooling } from './fim-embedder';

const PROFILES: Record<string, FimEmbedderProfile> = {
    'jina-code': {
        id: 'jina-code',
        llamaModel: 'jina-code-embeddings-0.5b',
        pooling: FimPooling.LastToken,
        dimension: 896,
        queryInstruction: 'Represent the incomplete code for completion: ',
        documentInstruction: 'Represent the code snippet for retrieval: ',
        matryoshkaDim: null,
    },
    granite: {
        id: 'granite',
        llamaModel: 'granite-embedding-311M-multilingual-r2',
        pooling: FimPooling.Mean,
        dimension: 768,
        queryInstruction: null,
        documentInstruction: null,
        matryoshkaDim: null,
    },
    'qwen3-0.6b': {
        id: 'qwen3-0.6b',
        llamaModel: 'Qwen3-Embedding-0.6B',
        pooling: FimPooling.LastToken,
        dimension: 1024,
        queryInstruction: 'Instruct: Retrieve relevant code for completion\nQuery: ',
        documentInstruction: null,
        matryoshkaDim: null,
    },
    'nomic-code': {
        id: 'nomic-code',
        llamaModel: 'nomic-embed-code',
        pooling: FimPooling.LastToken,
        dimension: 768,
        queryInstruction: null,
        documentInstruction: null,
        matryoshkaDim: null,
    },
};

export const DEFAULT_FIM_EMBEDDER_ID = 'jina-code';

export function getFimEmbedderProfile(id: string): FimEmbedderProfile {
    return PROFILES[id] ?? PROFILES[DEFAULT_FIM_EMBEDDER_ID];
}
