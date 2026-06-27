import { getFimModule } from '../../../common/fim/fim-model-registry';
import type { FimModelModule, FimPromptRenderInput } from '../../../common/fim/fim-model-module';
import type { Neighbor } from '../../../common/embedding-types';
import type { FimRelatedFile } from '../../../common/fim-types';
import type { RecentEdit } from '../../../common/edit-history-types';
import type { GenerationMode, FimModelId } from '../../../common/model-types';
import { FileMode } from '../../../common/mode-types';
import { normalizeCrlf } from '../../util/crlf';
import { fimMaxTokens, fimStopTokens, getFimModelSpec } from './model-spec';
import { trimFimContext } from './semantic-trim';

export interface BuildFimPromptInput {
    modelId: FimModelId;
    languageId?: string;
    fileMode: FileMode;
    prefix: string;
    suffix: string;
    generationMode: GenerationMode;
    contextSize: number;
    repoName?: string;
    filePath?: string;
    neighbors?: Neighbor[];
    relatedFiles?: FimRelatedFile[];
    recentEdits?: RecentEdit[];
    maxRecentEditSnippets?: number;
}

export interface BuiltFimPrompt {
    prompt: string;
    stop: string[];
    maxTokens: number;
    llamaModel: string;
}

interface PreparedRepoContext {
    neighbors: Neighbor[];
    relatedFiles: FimRelatedFile[];
    editSnippets: string[];
    reservedChars: number;
    useRepoContext: boolean;
}

export function buildFimPrompt(input: BuildFimPromptInput): BuiltFimPrompt {
    const spec = getFimModelSpec(input.modelId);
    const module = getFimModule(input.modelId);
    const repoContext = prepareRepoContext(input, module);
    const trimmed = trimFimContext(normalizeCrlf(input.prefix), normalizeCrlf(input.suffix), {
        fileMode: input.fileMode,
        contextSize: input.contextSize,
        reservedChars: repoContext.reservedChars,
    });
    const prompt = buildPromptText(input, module, trimmed.prefix, trimmed.suffix, repoContext);
    return {
        prompt,
        stop: fimStopTokens(spec),
        maxTokens: fimMaxTokens(spec, input.generationMode),
        llamaModel: spec.llamaModel,
    };
}

function prepareRepoContext(input: BuildFimPromptInput, module: FimModelModule): PreparedRepoContext {
    if (!module.supportsRepoContext) {
        return emptyRepoContext();
    }
    const neighbors = normalizeNeighbors(input.neighbors ?? []);
    const relatedFiles = normalizeRelatedFiles(input.relatedFiles ?? []);
    const editSnippets = buildRepoEditSnippets(input, module);
    const useRepoContext = neighbors.length > 0 || relatedFiles.length > 0 || editSnippets.length > 0;
    return {
        neighbors,
        relatedFiles,
        editSnippets,
        // reservedChars заранее резервирует место под repo-blocks, чтобы trim не выдавил текущий файл целиком.
        reservedChars: useRepoContext ? countReservedChars(input, module, neighbors, relatedFiles, editSnippets) : 0,
        useRepoContext,
    };
}

function buildRepoEditSnippets(input: BuildFimPromptInput, module: FimModelModule): string[] {
    const maxRecentEditSnippets = input.maxRecentEditSnippets ?? 3;
    const recentEdits = input.recentEdits ?? [];
    if (recentEdits.length === 0 || maxRecentEditSnippets <= 0) {
        return [];
    }
    return module.buildEditSnippets(input.languageId ?? '', recentEdits, maxRecentEditSnippets);
}

function buildPromptText(
    input: BuildFimPromptInput,
    module: FimModelModule,
    prefix: string,
    suffix: string,
    repoContext: PreparedRepoContext,
): string {
    return module.renderPrompt(toPromptRenderInput(input, prefix, suffix, repoContext));
}

function normalizeNeighbors(neighbors: Neighbor[]): Neighbor[] {
    return neighbors.map(neighbor => ({
        ...neighbor,
        text: normalizeCrlf(neighbor.text),
    }));
}

function normalizeRelatedFiles(files: FimRelatedFile[]): FimRelatedFile[] {
    return files.map(file => ({
        ...file,
        content: normalizeCrlf(file.content),
    }));
}

function toPromptRenderInput(
    input: BuildFimPromptInput,
    prefix: string,
    suffix: string,
    repoContext: PreparedRepoContext,
): FimPromptRenderInput {
    return {
        languageId: input.languageId ?? '',
        repoName: input.repoName ?? 'workspace',
        filePath: input.filePath ?? 'current-file',
        prefix,
        suffix,
        neighbors: repoContext.neighbors,
        relatedFiles: repoContext.relatedFiles,
        editSnippets: repoContext.editSnippets,
        useRepoContext: repoContext.useRepoContext,
    };
}

function countReservedChars(
    input: BuildFimPromptInput,
    module: FimModelModule,
    neighbors: Neighbor[],
    relatedFiles: FimRelatedFile[],
    editSnippets: string[],
): number {
    return module.countReservedChars({
        languageId: input.languageId ?? '',
        repoName: input.repoName ?? 'workspace',
        filePath: input.filePath ?? 'current-file',
        prefix: '',
        suffix: '',
        neighbors,
        relatedFiles,
        editSnippets,
        useRepoContext: true,
    });
}

function emptyRepoContext(): PreparedRepoContext {
    return {
        neighbors: [],
        relatedFiles: [],
        editSnippets: [],
        reservedChars: 0,
        useRepoContext: false,
    };
}
