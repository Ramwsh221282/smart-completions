import { ZetaLogger } from '../../../common/zeta21/logger';
import { renderRegions } from '../../../common/zeta21/markers';
import { ZETA_STOP_TOKENS, ZETA_TOKENS } from '../../../common/zeta21/types';
import type { ZetaEditableRegion, ZetaRelatedFile } from '../../../common/zeta21/types';

// Логгер строителя промпта нужен для инспекции training-format и точного сравнения со sweep/legacy zeta в debug-сессиях.
const LOG = new ZetaLogger('node:prompt-creating:zeta-prompt-builder');

// Вход сборки содержит уже обрезанные по бюджету SPM-зоны и готовый edit_history block.
export interface BuildZetaPromptInput {
    targetPath: string;
    prefixBeforeRegion: string;
    windowText: string;
    suffixText: string;
    cursorOffset: number;
    regions: ZetaEditableRegion[];
    relatedFiles: ZetaRelatedFile[];
    editHistoryBlock: string;
}

// Готовый промпт с параметрами вызова llama.cpp передаётся напрямую в LlamaZetaClient.
export interface BuiltZetaPrompt {
    prompt: string;
    stop: string[];
}

/** Собирает канонический Zeta 2.1 SPM prompt в порядке suffix -> prefix -> middle, не меняя on-distribution разметку модели. */
export function buildZetaPrompt(input: BuildZetaPromptInput): BuiltZetaPrompt {
    const prefixBlocks = buildPrefixBlocks(input);
    const prefixStream = prefixBlocks.length > 0 ? `${ZETA_TOKENS.fimPrefix}${prefixBlocks.join('\n\n')}` : ZETA_TOKENS.fimPrefix;
    const prompt = [ZETA_TOKENS.fimSuffix, input.suffixText, prefixStream, ZETA_TOKENS.fimMiddle].join('\n');
    LOG.info('Zeta prompt built', {
        targetPath: input.targetPath,
        related: input.relatedFiles.length,
        regions: input.regions.length,
        promptChars: prompt.length,
    });
    LOG.prompt('zeta-spm', prompt, { targetPath: input.targetPath, related: input.relatedFiles.length, regions: input.regions.length });
    return { prompt, stop: [...ZETA_STOP_TOKENS] };
}

function buildPrefixBlocks(input: BuildZetaPromptInput): string[] {
    const blocks: string[] = [];
    for (let i = 0; i < input.relatedFiles.length; i++) {
        const related = input.relatedFiles[i];
        blocks.push(`${ZETA_TOKENS.filename}${related.filePath}\n${related.content}`);
    }
    if (input.editHistoryBlock) {
        blocks.push(input.editHistoryBlock);
    }
    blocks.push(buildTargetBlock(input));
    return blocks;
}

function buildTargetBlock(input: BuildZetaPromptInput): string {
    const lines = [`${ZETA_TOKENS.filename}${input.targetPath}`];
    if (input.prefixBeforeRegion) {
        lines.push(input.prefixBeforeRegion);
    }
    lines.push(renderTargetRegions(input.windowText, input.regions, input.cursorOffset));
    return lines.join('\n');
}

function renderTargetRegions(windowText: string, regions: ZetaEditableRegion[], cursorOffset: number): string {
    if (regions.length === 1 && regions[0].startOffset === 0 && regions[0].endOffset === windowText.length) {
        const marker = regions[0].markerIndex;
        const safeCursor = Math.max(0, Math.min(cursorOffset, windowText.length));
        return [`<|marker_${marker}|>`, `${windowText.slice(0, safeCursor)}${ZETA_TOKENS.userCursor}${windowText.slice(safeCursor)}`, `<|marker_${marker + 1}|>`].join('\n');
    }
    return renderRegions(windowText, regions, cursorOffset);
}
