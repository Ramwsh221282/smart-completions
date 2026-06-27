import type { Neighbor } from '../embedding-types';
import type { FimRelatedFile } from '../fim-types';
import type { FimTokenSet } from '../fim/fim-model-module';
import { QWEN_FILE_TOKEN, QWEN_REPO_NAME_TOKEN } from './qwen-tokens';

export interface BuildQwenPromptInput {
    repoName: string;
    filePath: string;
    prefix: string;
    suffix: string;
    neighbors: Neighbor[];
    relatedFiles: FimRelatedFile[];
    editSnippets: string[];
    useRepoContext: boolean;
    tokens: FimTokenSet;
}

export function renderQwenPrompt(input: BuildQwenPromptInput): string {
    const currentFim = renderFileLevelFim(input.tokens, input.prefix, input.suffix);
    if (!input.useRepoContext) {
        return currentFim;
    }
    return renderRepoPrompt(input.repoName, input.filePath, input.neighbors, input.relatedFiles, input.editSnippets, currentFim);
}

function renderFileLevelFim(tokens: FimTokenSet, prefix: string, suffix: string): string {
    return `${tokens.prefix}${prefix}${tokens.suffix}${suffix}${tokens.middle}`;
}

function renderRepoPrompt(
    repoName: string,
    filePath: string,
    neighbors: Neighbor[],
    relatedFiles: FimRelatedFile[],
    editSnippets: string[],
    currentFim: string,
): string {
    const chunks = [`${QWEN_REPO_NAME_TOKEN}${repoName}`];
    for (let i = neighbors.length - 1; i >= 0; i--) {
        const neighbor = neighbors[i];
        chunks.push(`${QWEN_FILE_TOKEN}${neighbor.filePath}\n${neighbor.text}`);
    }
    for (let i = 0; i < relatedFiles.length; i++) {
        const related = relatedFiles[i];
        chunks.push(`${QWEN_FILE_TOKEN}${related.filePath}\n${related.content}`);
    }
    for (let i = 0; i < editSnippets.length; i++) {
        chunks.push(editSnippets[i]);
    }
    chunks.push(`${QWEN_FILE_TOKEN}${filePath}\n${currentFim}`);
    return chunks.join('\n');
}
