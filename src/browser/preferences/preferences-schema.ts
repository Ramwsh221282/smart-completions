import { PreferenceSchema } from '@theia/core/lib/common/preferences/preference-schema';
import { PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import { EmbeddingConfig } from '../../common/embedding-types';
import { FimConfig } from '../../common/fim-types';
import { NesConfig } from '../../common/nes-types';
import { EmbedModelId, FimModelId, GenerationMode, NesModelId, VectorDbId } from '../../common/model-types';
import { SweepProfileId, getSweepProfile, sweepProfileIdForModel, sweepRequestModelName } from '../../common/sweep/profiles';

/** Схема настроек smart-completions для FIM/NES, coordination mode и embedding-инфраструктуры. */
export const SMART_COMPLETIONS_PREFERENCE_SCHEMA: PreferenceSchema = {
    properties: {
        'smart-completions.coordinationMode': {
            type: 'string',
            enum: ['exclusive-priority', 'parallel', 'fim-only', 'nes-only', 'nes-priority'],
            default: 'exclusive-priority',
            description: 'How FIM and NES rendering are coordinated.',
        },
        'smart-completions.fim.enabled': {
            type: 'boolean',
            default: true,
            description: 'Enable FIM ghost-text completions.',
        },
        'smart-completions.fim.modelId': {
            type: 'string',
            enum: ['qwen2.5-coder', 'deepseek-coder', 'omnicoder', 'granite-4.1-8b', 'granite-4.1-3b'],
            default: 'qwen2.5-coder',
            description: 'Active FIM model served by llama.cpp.',
        },
        'smart-completions.fim.llamaUrl': {
            type: 'string',
            default: 'http://127.0.0.1:8010/v1',
            description: 'llama.cpp base URL for FIM completions (include /v1 if required).',
        },
        'smart-completions.fim.contextSize': {
            type: 'number',
            default: 0,
            description: 'FIM context window. Use 0 to use the known maximum for the selected model.',
        },
        'smart-completions.fim.debounceMs': {
            type: 'number',
            default: 120,
            description: 'Delay after typing before automatic FIM requests.',
        },
        'smart-completions.fim.generationMode': {
            type: 'string',
            enum: ['line', 'multiline', 'block'],
            default: 'multiline',
            description: 'Amount of generated FIM code: line, multiline, or block.',
        },
        'smart-completions.fim.temperature': {
            type: 'number',
            default: 0.05,
            minimum: 0,
            maximum: 0.1,
            description: 'FIM sampling temperature.',
        },
        'smart-completions.fim.ragEnabled': {
            type: 'boolean',
            default: true,
            description: 'Include retrieved repository chunks when the active FIM model has repo slots.',
        },
        'smart-completions.fim.contextSources.recentEdits': {
            type: 'boolean',
            default: false,
            description: 'Allow recent edits as FIM context when a model template exposes a compatible slot.',
        },
        'smart-completions.fim.contextSources.repoContext': {
            type: 'boolean',
            default: true,
            description: 'Allow retrieved repository chunks as FIM context when a model template exposes repo slots.',
        },
        'smart-completions.fim.contextSources.diagnostics': {
            type: 'boolean',
            default: false,
            description: 'Allow diagnostics as FIM context when a model template exposes a compatible slot.',
        },
        'smart-completions.nes.enabled': {
            type: 'boolean',
            default: true,
            description: 'Enable Next Edit Suggestions in a View Zone.',
        },
        'smart-completions.nes.modelId': {
            type: 'string',
            enum: ['sweep-default', 'sweep-small', 'zeta', 'zeta-2.1'],
            default: 'sweep-default',
            description: 'Active NES model served by llama.cpp.',
        },
        'smart-completions.nes.llamaUrl': {
            type: 'string',
            default: 'http://127.0.0.1:8030/v1',
            description: 'llama.cpp base URL for NES completions (include /v1 if required).',
        },
        'smart-completions.nes.sweepSmallSize': {
            type: 'string',
            enum: ['1.5b', '0.5b'],
            default: '1.5b',
            description: 'Sweep-small profile size used for context window and output budget.',
        },
        'smart-completions.nes.requestModelName': {
            type: 'string',
            default: '',
            description: 'Exact llama.cpp model name for NES requests. Empty uses the Sweep profile default.',
        },
        'smart-completions.nes.contextSize': {
            type: 'number',
            default: 16384,
            description: 'NES context window for prompt assembly.',
        },
        'smart-completions.nes.debounceMs': {
            type: 'number',
            default: 500,
            description: 'Delay after edits before NES requests.',
        },
        'smart-completions.nes.editVolume': {
            type: 'string',
            enum: ['small', 'medium', 'large'],
            default: 'medium',
            description: 'Size of the proposed edit.',
        },
        'smart-completions.nes.ragEnabled': {
            type: 'boolean',
            default: true,
            description: 'Include retrieved repository chunks in NES prompts.',
        },
        'smart-completions.nes.injectInlineDiagnostics': {
            type: 'boolean',
            default: false,
            description: 'Inject inline diagnostics for sweep-small models.',
        },
        'smart-completions.nes.relatedTopN': {
            type: 'number',
            default: 5,
            description: 'How many related files (search-in-workspace / LSP hierarchy / SCM) to attach as NES context.',
        },
        'smart-completions.nes.queryMaxChars': {
            type: 'number',
            default: 400,
            description: 'Character budget for NES retrieval / related-file queries built from the edit signal.',
        },
        'smart-completions.embedding.embedModel': {
            type: 'string',
            default: 'nomic',
            description: 'Embedding model name sent to llama.cpp /v1/embeddings. Any model is allowed; short aliases nomic/granite expand to full names.',
        },
        'smart-completions.embedding.llamaUrl': {
            type: 'string',
            default: 'http://127.0.0.1:8020/v1',
            description: 'llama.cpp base URL for embeddings (include /v1 if required).',
        },
        'smart-completions.embedding.vectorDb': {
            type: 'string',
            enum: ['lancedb', 'chromadb'],
            default: 'lancedb',
            description: 'Vector store: lancedb (embedded) or chromadb (server).',
        },
        'smart-completions.embedding.chromaUrl': {
            type: 'string',
            default: 'http://127.0.0.1:8000',
            description: 'ChromaDB server URL (when vectorDb = chromadb).',
        },
        'smart-completions.embedding.indexOnSave': {
            type: 'boolean',
            default: true,
            description: 'Reindex a file on save.',
        },
        'smart-completions.embedding.indexOnOpen': {
            type: 'boolean',
            default: true,
            description: 'Index / reconcile the repository when a workspace opens.',
        },
        'smart-completions.embedding.chunkSize': {
            type: 'number',
            default: 40,
            description: 'Prose chunk window (lines).',
        },
        'smart-completions.embedding.topN': {
            type: 'number',
            default: 4,
            description: 'Retrieval: number of neighbor chunks.',
        },
        'smart-completions.embedding.prefixTailChars': {
            type: 'number',
            default: 400,
            description: 'Retrieval query = last N characters of the prefix.',
        },
    },
};

const FIM_CONTEXT_MAX: Record<FimModelId, number> = {
    'qwen2.5-coder': 32768,
    'deepseek-coder': 16384,
    omnicoder: 32768,
    'granite-4.1-8b': 128000,
    'granite-4.1-3b': 128000,
};

/** Собрать FimConfig из PreferenceService. */
export function readFimConfig(preferences: PreferenceService): FimConfig {
    const modelId = preferences.get<FimModelId>('smart-completions.fim.modelId', 'qwen2.5-coder');
    const configuredContextSize = preferences.get<number>('smart-completions.fim.contextSize', 0);
    return {
        modelId,
        llamaUrl: preferences.get<string>('smart-completions.fim.llamaUrl', 'http://127.0.0.1:8010/v1'),
        contextSize: configuredContextSize > 0 ? configuredContextSize : FIM_CONTEXT_MAX[modelId],
        debounceMs: preferences.get<number>('smart-completions.fim.debounceMs', 120),
        generationMode: preferences.get<GenerationMode>('smart-completions.fim.generationMode', 'multiline'),
        temperature: preferences.get<number>('smart-completions.fim.temperature', 0.05),
        ragEnabled: preferences.get<boolean>('smart-completions.fim.ragEnabled', true),
        contextSources: {
            recentEdits: preferences.get<boolean>('smart-completions.fim.contextSources.recentEdits', false),
            repoContext: preferences.get<boolean>('smart-completions.fim.contextSources.repoContext', true),
            diagnostics: preferences.get<boolean>('smart-completions.fim.contextSources.diagnostics', false),
        },
    };
}

/** Собрать NesConfig из PreferenceService. */
export function readNesConfig(preferences: PreferenceService): NesConfig {
    const modelId = preferences.get<NesModelId>('smart-completions.nes.modelId', 'sweep-default');
    const smallSize = preferences.get<SweepProfileId>('smart-completions.nes.sweepSmallSize', '1.5b');
    const profileId = sweepProfileIdForModel(modelId, smallSize);
    const profile = getSweepProfile(profileId);
    const requestModelName = sweepRequestModelName(
        profileId,
        preferences.get<string>('smart-completions.nes.requestModelName', ''),
    );
    return {
        modelId,
        llamaUrl: preferences.get<string>('smart-completions.nes.llamaUrl', 'http://127.0.0.1:8030/v1'),
        contextSize: preferences.get<number>('smart-completions.nes.contextSize', 16384),
        debounceMs: preferences.get<number>('smart-completions.nes.debounceMs', 500),
        editVolume: preferences.get<'small' | 'medium' | 'large'>('smart-completions.nes.editVolume', 'medium'),
        ragEnabled: preferences.get<boolean>('smart-completions.nes.ragEnabled', true),
        injectInlineDiagnostics: preferences.get<boolean>('smart-completions.nes.injectInlineDiagnostics', false),
        relatedTopN: preferences.get<number>('smart-completions.nes.relatedTopN', 5),
        queryMaxChars: preferences.get<number>('smart-completions.nes.queryMaxChars', 400),
        profile,
        requestModelName,
    };
}

/** Собрать EmbeddingConfig из PreferenceService. */
export function readEmbeddingConfig(preferences: PreferenceService): EmbeddingConfig {
    return {
        embedModel: preferences.get<EmbedModelId>('smart-completions.embedding.embedModel', 'nomic'),
        llamaUrl: preferences.get<string>('smart-completions.embedding.llamaUrl', 'http://127.0.0.1:8020/v1'),
        vectorDb: preferences.get<VectorDbId>('smart-completions.embedding.vectorDb', 'lancedb'),
        chromaUrl: preferences.get<string>('smart-completions.embedding.chromaUrl', 'http://127.0.0.1:8000'),
        indexOnSave: preferences.get<boolean>('smart-completions.embedding.indexOnSave', true),
        indexOnOpen: preferences.get<boolean>('smart-completions.embedding.indexOnOpen', true),
        chunkSize: preferences.get<number>('smart-completions.embedding.chunkSize', 40),
        topN: preferences.get<number>('smart-completions.embedding.topN', 4),
        prefixTailChars: preferences.get<number>('smart-completions.embedding.prefixTailChars', 400),
    };
}
