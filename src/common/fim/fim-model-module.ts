import type { RecentEdit } from '../edit-history-types';
import type { Neighbor } from '../embedding-types';
import type { FimRelatedFile } from '../fim-types';
import type { GenerationMode, FimModelId, FimTemplateId } from '../model-types';

export type FimRepoFormat = 'file-sep' | 'comment' | 'aixcoder' | 'seed' | null;

export interface FimTokenSet {
    prefix: string;
    suffix: string;
    middle: string;
    extraStops: string[];
}

export interface FimPromptRenderInput {
    languageId: string;
    repoName: string;
    filePath: string;
    prefix: string;
    suffix: string;
    neighbors: Neighbor[];
    relatedFiles: FimRelatedFile[];
    editSnippets: string[];
    useRepoContext: boolean;
}

export interface FimModelModule {
    modelId: FimModelId;
    templateId: FimTemplateId;
    llamaModel: string;
    tokens: FimTokenSet;
    supportsRepoContext: boolean;
    repoFormat: FimRepoFormat;
    contextTokens: number;
    embedderId: string;
    renderPrompt(input: FimPromptRenderInput): string;
    buildEditSnippets(languageId: string, recentEdits: RecentEdit[], maxEdits: number): string[];
    countReservedChars(input: FimPromptRenderInput): number;
    maxTokensForMode(generationMode: GenerationMode): number;
}
