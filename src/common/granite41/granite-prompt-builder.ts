import type { Neighbor } from '../embedding-types';
import { buildEditHistorySnippets } from '../fim/fim-udiff';
import type { FimRelatedFile } from '../fim-types';
import { lineCommentForLanguage } from './line-comment';

interface GranitePromptTokens {
    prefix: string;
    suffix: string;
    middle: string;
}

export interface BuildGranitePromptInput {
    languageId: string;
    filePath?: string;
    prefix: string;
    suffix: string;
    neighbors: Neighbor[];
    relatedFiles: FimRelatedFile[];
    editSnippets: string[];
    tokens: GranitePromptTokens;
}

export function buildGraniteEditSnippets(languageId: string, recentEdits: Array<{ uri: string; before?: string; after?: string; unifiedDiff: string; timestamp: number }>, maxEdits: number): string[] {
    return buildEditHistorySnippets(`${lineCommentForLanguage(languageId)} edit_history `, recentEdits, maxEdits);
}

export function renderGranitePrompt(input: BuildGranitePromptInput): string {
    const blocks = buildGranitePrefixBlocks(input);
    return `${input.tokens.prefix}${blocks}${input.tokens.suffix}${input.suffix}${input.tokens.middle}`;
}

function buildGranitePrefixBlocks(input: BuildGranitePromptInput): string {
    const comment = lineCommentForLanguage(input.languageId);
    const blocks: string[] = [];

    pushNeighborBlocks(blocks, input.neighbors, comment);
    pushRelatedFileBlocks(blocks, input.relatedFiles, comment);
    pushEditBlocks(blocks, input.editSnippets);
    blocks.push(`${comment} ${input.filePath ?? 'current-file'}\n${input.prefix}`);

    return blocks.join('\n');
}

function pushNeighborBlocks(blocks: string[], neighbors: Neighbor[], comment: string): void {
    for (let i = neighbors.length - 1; i >= 0; i--) {
        const neighbor = neighbors[i];
        blocks.push(`${comment} ${neighbor.filePath}\n${neighbor.text}`);
    }
}

function pushRelatedFileBlocks(blocks: string[], relatedFiles: FimRelatedFile[], comment: string): void {
    for (let i = 0; i < relatedFiles.length; i++) {
        const related = relatedFiles[i];
        blocks.push(`${comment} ${related.filePath}\n${related.content}`);
    }
}

function pushEditBlocks(blocks: string[], editSnippets: string[]): void {
    for (let i = 0; i < editSnippets.length; i++) {
        blocks.push(editSnippets[i]);
    }
}
