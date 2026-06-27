import { buildGraniteEditSnippets, renderGranitePrompt } from '../../../common/granite41/granite-prompt-builder';
import type { Neighbor } from '../../../common/embedding-types';
import { buildEditHistorySnippets } from '../../../common/fim/fim-udiff';
import type { FimRelatedFile } from '../../../common/fim-types';
import type { RecentEdit } from '../../../common/edit-history-types';
import { GenerationMode, FimModelId } from '../../../common/model-types';
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
    const repoContext = prepareRepoContext(input, spec);
    const trimmed = trimFimContext(normalizeCrlf(input.prefix), normalizeCrlf(input.suffix), {
        fileMode: input.fileMode,
        contextSize: input.contextSize,
        reservedChars: repoContext.reservedChars,
    });
    const prompt = buildPromptText(input, spec, trimmed.prefix, trimmed.suffix, repoContext);
    return {
        prompt,
        stop: fimStopTokens(spec),
        maxTokens: fimMaxTokens(input.generationMode),
        llamaModel: spec.llamaModel,
    };
}

function prepareRepoContext(input: BuildFimPromptInput, spec: ReturnType<typeof getFimModelSpec>): PreparedRepoContext {
    if (!spec.supportsRepoContext) {
        return emptyRepoContext();
    }
    const neighbors = normalizeNeighbors(input.neighbors ?? []);
    const relatedFiles = normalizeRelatedFiles(input.relatedFiles ?? []);
    const editSnippets = buildRepoEditSnippets(input, spec);
    return {
        neighbors,
        relatedFiles,
        editSnippets,
        reservedChars: countReservedChars(neighbors, relatedFiles, editSnippets),
        useRepoContext: neighbors.length > 0 || relatedFiles.length > 0 || editSnippets.length > 0,
    };
}

function buildRepoEditSnippets(input: BuildFimPromptInput, spec: ReturnType<typeof getFimModelSpec>): string[] {
    const maxRecentEditSnippets = input.maxRecentEditSnippets ?? 3;
    const recentEdits = input.recentEdits ?? [];
    if (recentEdits.length === 0 || maxRecentEditSnippets <= 0) {
        return [];
    }
    if (spec.repoFormat === 'comment') {
        return buildGraniteEditSnippets(input.languageId ?? '', recentEdits, maxRecentEditSnippets);
    }
    if (hasTokenRepoSlots(spec)) {
        return buildEditHistorySnippets(spec.fileToken, recentEdits, maxRecentEditSnippets);
    }
    return [];
}

function buildPromptText(
    input: BuildFimPromptInput,
    spec: ReturnType<typeof getFimModelSpec>,
    prefix: string,
    suffix: string,
    repoContext: PreparedRepoContext,
): string {
    if (!repoContext.useRepoContext) {
        return renderFileLevelFim(spec.tokens, prefix, suffix);
    }
    if (spec.repoFormat === 'comment') {
        return renderGranitePrompt({
            languageId: input.languageId ?? '',
            filePath: input.filePath,
            prefix,
            suffix,
            neighbors: repoContext.neighbors,
            relatedFiles: repoContext.relatedFiles,
            editSnippets: repoContext.editSnippets,
            tokens: spec.tokens,
        });
    }
    if (hasTokenRepoSlots(spec)) {
        return renderRepoPrompt(
            spec.repoNameToken,
            spec.fileToken,
            input.repoName,
            input.filePath,
            repoContext.neighbors,
            repoContext.relatedFiles,
            repoContext.editSnippets,
            renderFileLevelFim(spec.tokens, prefix, suffix),
        );
    }
    return renderFileLevelFim(spec.tokens, prefix, suffix);
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

function renderFileLevelFim(tokens: { prefix: string; suffix: string; middle: string }, prefix: string, suffix: string): string {
    return `${tokens.prefix}${prefix}${tokens.suffix}${suffix}${tokens.middle}`;
}

function hasTokenRepoSlots(spec: ReturnType<typeof getFimModelSpec>): spec is ReturnType<typeof getFimModelSpec> & { repoNameToken: string; fileToken: string } {
    return Boolean(spec.repoNameToken && spec.fileToken);
}

function countReservedChars(neighbors: Neighbor[], relatedFiles: FimRelatedFile[], editSnippets: string[]): number {
    return neighbors.reduce((sum, neighbor) => sum + neighbor.text.length + neighbor.filePath.length + 8, 0)
        + relatedFiles.reduce((sum, file) => sum + file.content.length + file.filePath.length + 8, 0)
        + editSnippets.reduce((sum, snippet) => sum + snippet.length, 0);
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

function renderRepoPrompt(
    repoNameToken: string,
    fileToken: string,
    repoName = 'workspace',
    filePath = 'current-file',
    neighbors: Neighbor[],
    relatedFiles: FimRelatedFile[],
    editSnippets: string[],
    currentFim: string,
): string {
    const chunks = [`${repoNameToken}${repoName}`];
    for (let i = neighbors.length - 1; i >= 0; i--) {
        const neighbor = neighbors[i];
        chunks.push(`${fileToken}${neighbor.filePath}\n${neighbor.text}`);
    }
    for (let i = 0; i < relatedFiles.length; i++) {
        const related = relatedFiles[i];
        chunks.push(`${fileToken}${related.filePath}\n${related.content}`);
    }
    for (let i = 0; i < editSnippets.length; i++) {
        chunks.push(editSnippets[i]);
    }
    chunks.push(`${fileToken}${filePath}\n${currentFim}`);
    return chunks.join('\n');
}
