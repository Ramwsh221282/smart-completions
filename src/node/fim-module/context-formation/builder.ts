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

export function buildFimPrompt(input: BuildFimPromptInput): BuiltFimPrompt {
    const spec = getFimModelSpec(input.modelId);
    const repoTokens = spec.supportsRepoContext && spec.repoNameToken && spec.fileToken
        ? { repoNameToken: spec.repoNameToken, fileToken: spec.fileToken }
        : undefined;
    const normalizedNeighbors = spec.supportsRepoContext ? normalizeNeighbors(input.neighbors ?? []) : [];
    const normalizedRelatedFiles = spec.supportsRepoContext ? normalizeRelatedFiles(input.relatedFiles ?? []) : [];
    const editSnippets = repoTokens
        ? buildEditHistorySnippets(repoTokens.fileToken, input.recentEdits ?? [], input.maxRecentEditSnippets ?? 3)
        : [];
    const reservedChars = normalizedNeighbors.reduce((sum, n) => sum + n.text.length + n.filePath.length + 8, 0)
        + normalizedRelatedFiles.reduce((sum, file) => sum + file.content.length + file.filePath.length + 8, 0)
        + editSnippets.reduce((sum, snippet) => sum + snippet.length, 0);
    const trimmed = trimFimContext(normalizeCrlf(input.prefix), normalizeCrlf(input.suffix), {
        fileMode: input.fileMode,
        contextSize: input.contextSize,
        reservedChars,
    });
    const fim = `${spec.tokens.prefix}${trimmed.prefix}${spec.tokens.suffix}${trimmed.suffix}${spec.tokens.middle}`;
    // Repo-слоты включаем только когда есть реальный внешний контекст: retrieval, LSP-related или recent edits.
    const useRepoContext = Boolean(repoTokens) && (normalizedNeighbors.length > 0 || normalizedRelatedFiles.length > 0 || editSnippets.length > 0);
    const prompt = useRepoContext && repoTokens
        ? renderRepoPrompt(
            repoTokens.repoNameToken,
            repoTokens.fileToken,
            input.repoName,
            input.filePath,
            normalizedNeighbors,
            normalizedRelatedFiles,
            editSnippets,
            fim,
        )
        : fim;
    return {
        prompt,
        stop: fimStopTokens(spec),
        maxTokens: fimMaxTokens(input.generationMode),
        llamaModel: spec.llamaModel,
    };
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
