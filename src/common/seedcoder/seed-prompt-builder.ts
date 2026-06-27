import type { Neighbor } from '../embedding-types';
import { buildEditHistorySnippets } from '../fim/fim-udiff';
import type { FimRelatedFile } from '../fim-types';
import type { RecentEdit } from '../edit-history-types';
import { lineCommentForLanguage } from '../granite41/line-comment';
import { SEED_FIM_MIDDLE, SEED_FIM_PREFIX, SEED_FIM_SUFFIX } from './seed-tokens';

export interface BuildSeedPromptInput {
    languageId: string;
    filePath: string;
    prefix: string;
    suffix: string;
    neighbors: Neighbor[];
    relatedFiles: FimRelatedFile[];
    editSnippets: string[];
}

export function buildSeedEditSnippets(languageId: string, recentEdits: RecentEdit[], maxEdits: number): string[] {
    return buildEditHistorySnippets(`${lineCommentForLanguage(languageId)} edit_history `, recentEdits, maxEdits);
}

export function renderSeedPrompt(input: BuildSeedPromptInput): string {
    return `${SEED_FIM_SUFFIX}${input.suffix}${SEED_FIM_PREFIX}${buildPrefixSection(input)}${SEED_FIM_MIDDLE}`;
}

function buildPrefixSection(input: BuildSeedPromptInput): string {
    const comment = lineCommentForLanguage(input.languageId);
    const blocks: string[] = [];
    for (let i = input.neighbors.length - 1; i >= 0; i--) {
        const neighbor = input.neighbors[i];
        blocks.push(`${comment} ${neighbor.filePath}\n${neighbor.text}`);
    }
    for (let i = 0; i < input.relatedFiles.length; i++) {
        const related = input.relatedFiles[i];
        blocks.push(`${comment} ${related.filePath}\n${related.content}`);
    }
    for (let i = 0; i < input.editSnippets.length; i++) {
        blocks.push(input.editSnippets[i]);
    }
    blocks.push(`${comment} ${input.filePath}\n${input.prefix}`);
    return blocks.join('\n');
}
