import { createTwoFilesPatch } from 'diff';
import type { Neighbor } from '../embedding-types';
import type { RecentEdit } from '../edit-history-types';
import type { FimRelatedFile } from '../fim-types';
import { buildAixcoderHeader } from './aixcoder-header';
import { AIX_SPAN_MIDDLE, AIX_SPAN_POST, AIX_SPAN_PRE } from './aixcoder-tokens';

export interface BuildAixcoderPromptInput {
    languageId: string;
    filePath: string;
    prefix: string;
    suffix: string;
    neighbors: Neighbor[];
    relatedFiles: FimRelatedFile[];
    editSnippets: string[];
}

export function renderAixcoderPrompt(input: BuildAixcoderPromptInput): string {
    const currentHeader = buildAixcoderHeader(input.filePath, input.languageId);
    if (!hasRepoContext(input)) {
        return renderSpmPrompt(currentHeader, input.prefix, input.suffix);
    }
    return renderPsmPrompt(input, currentHeader);
}

export function buildAixcoderEditSnippets(languageId: string, recentEdits: RecentEdit[], maxEdits: number): string[] {
    if (maxEdits <= 0 || recentEdits.length === 0) {
        return [];
    }
    const ordered = recentEdits.slice().sort((left, right) => left.timestamp - right.timestamp);
    const count = ordered.length > maxEdits ? maxEdits : ordered.length;
    const out = new Array<string>(count);
    const start = ordered.length - count;
    for (let index = 0; index < count; index++) {
        const edit = ordered[start + index];
        out[index] = `${buildAixcoderHeader(edit.uri, languageId)}${buildUnifiedDiff(edit)}`;
    }
    return out;
}

function hasRepoContext(input: BuildAixcoderPromptInput): boolean {
    return input.neighbors.length > 0 || input.relatedFiles.length > 0 || input.editSnippets.length > 0;
}

function renderPsmPrompt(input: BuildAixcoderPromptInput, currentHeader: string): string {
    const prefixWithRepoContext = `${buildRepoBlocks(input)}${currentHeader}${input.prefix}`;
    return `${AIX_SPAN_PRE}${prefixWithRepoContext}${AIX_SPAN_POST}${input.suffix}${AIX_SPAN_MIDDLE}`;
}

function renderSpmPrompt(currentHeader: string, prefix: string, suffix: string): string {
    return `${AIX_SPAN_PRE}${AIX_SPAN_POST}${suffix}${AIX_SPAN_MIDDLE}${currentHeader}${prefix}`;
}

function buildRepoBlocks(input: BuildAixcoderPromptInput): string {
    const blocks: string[] = [];
    pushNeighborBlocks(blocks, input);
    pushRelatedFileBlocks(blocks, input);
    pushEditBlocks(blocks, input.editSnippets);
    return blocks.join('');
}

function pushNeighborBlocks(blocks: string[], input: BuildAixcoderPromptInput): void {
    for (let index = input.neighbors.length - 1; index >= 0; index--) {
        const neighbor = input.neighbors[index];
        blocks.push(`${buildAixcoderHeader(neighbor.filePath, input.languageId)}${neighbor.text}\n`);
    }
}

function pushRelatedFileBlocks(blocks: string[], input: BuildAixcoderPromptInput): void {
    for (let index = 0; index < input.relatedFiles.length; index++) {
        const relatedFile = input.relatedFiles[index];
        blocks.push(`${buildAixcoderHeader(relatedFile.filePath, input.languageId)}${relatedFile.content}\n`);
    }
}

function pushEditBlocks(blocks: string[], editSnippets: string[]): void {
    for (let index = 0; index < editSnippets.length; index++) {
        blocks.push(`${editSnippets[index]}\n`);
    }
}

function buildUnifiedDiff(edit: RecentEdit): string {
    if (typeof edit.before === 'string' && typeof edit.after === 'string') {
        return createTwoFilesPatch(`a/${edit.uri}`, `b/${edit.uri}`, edit.before, edit.after, '', '', { context: 2 }).trimEnd();
    }
    return edit.unifiedDiff.trimEnd();
}
