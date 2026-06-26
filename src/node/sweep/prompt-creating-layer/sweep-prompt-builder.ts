import { SweepLogger } from '../../../common/sweep/logger';
import { getSweepProfile, sweepRequestModelName } from '../../../common/sweep/profiles';
import { SweepEditVolume } from '../../../common/sweep/types';
import { dedupeContextFiles } from '../../../common/sweep/dedup-context';
import { normalizeCrlf } from '../../../common/text/crlf';
import { trimSweepContext, BuildSweepPromptInput, TrimmedSweepContext, SWEEP_TEMPLATE_OVERHEAD_TOKENS } from '../data-formatting-layer/context-trimmer';
import { formatSweepDiagnosticsLines } from '../data-formatting-layer/diagnostics-format';
import { formatSweepDiffBlocks, unifiedDiffToOriginalUpdated } from '../data-formatting-layer/diff-blocks';
import { formatSweepCurrentFileBlock, formatSweepNeighborFileBlocks, formatSweepRelatedFileBlocks } from '../data-formatting-layer/file-blocks';

// Логгер строителя промпта; нужен для диагностики структуры промпта и печати полного текста для инспекции.
const LOG = new SweepLogger('node:prompt-creating');

export { BuildSweepPromptInput, unifiedDiffToOriginalUpdated };

// Готовый промпт с параметрами вызова llama.cpp; передаётся напрямую в LlamaSweepClient.
export interface BuiltSweepPrompt {
    prompt: string;
    stop: string[];
    maxTokens: number;
    model: string;
    format: 'sweep';
    overflow: boolean;
    prefill: string;
    /** Оценка размера промпта в токенах; точное значение используется только в development для калибровки. */
    promptTokens: number;
    tokenMode: 'tokenizer' | 'char-fallback';
    contextProfile: string;
}

/**
 * Точка входа строителя промпта: обрезает контекст, собирает секции, логирует полный промпт;
 * нужен потому что training-format требует строго определённого порядка блоков и стоп-токенов.
 */
export function buildSweepPrompt(input: BuildSweepPromptInput): BuiltSweepPrompt {
    const profile = input.profile ?? getSweepProfile(input.modelId === 'sweep-small' ? '1.5b' : 'v2-7b');
    const maxTokens = maxTokensForSweepVolume(input.editVolume, profile.maxOutputTokens);
    const deduped = dedupeContextFiles({
        currentFilePath: input.filePath,
        neighbors: input.neighbors ?? [],
        relatedFiles: input.relatedFiles ?? [],
    });
    const trimInput = { ...input, neighbors: deduped.neighbors, relatedFiles: deduped.relatedFiles };
    const trimmed = trimSweepContext(trimInput, maxTokens);
    const range = windowRange(input.windowStartLine ?? 0, trimmed.windowText);
    const sections = buildSweepSections(trimInput, trimmed, range);
    const prompt = sections.join('\n');
    const llamaModel = input.requestModelName ?? sweepRequestModelName(profile.id, '');
    const estimatedPromptTokens = trimmed.consumedTokens + SWEEP_TEMPLATE_OVERHEAD_TOKENS;
    let promptTokens = estimatedPromptTokens;
    if (process.env.NODE_ENV === 'development' && input.tokenCounter) {
        const exact = input.tokenCounter.count(prompt);
        LOG.debug('Sweep promptTokens estimate delta', {
            estimate: estimatedPromptTokens,
            exact,
            markupActual: exact - trimmed.consumedTokens,
        });
        promptTokens = exact;
    }
    const tokenMode = input.tokenCounter?.mode ?? 'char-fallback';
    LOG.info('Sweep prompt built', {
        modelId: input.modelId,
        llamaModel,
        contextProfile: profile.id,
        fileMode: input.fileMode ?? 'code',
        maxTokens,
        overflow: trimmed.overflow,
        blocks: sections.length,
        range,
        promptChars: prompt.length,
        neighbors: trimmed.neighbors.length,
        relatedFiles: trimmed.relatedFiles.length,
        broadFileChars: trimmed.broadFileText.length,
        recentEdits: trimmed.recentEdits.length,
        diagnostics: trimmed.diagnostics.length,
        hasOutline: Boolean(trimmed.outline),
        outputSnippets: trimmed.outputSnippets.length,
        dedupDropped: deduped.dropped,
        promptTokens,
        tokenMode,
    });
    LOG.prompt('training-format', prompt, { modelId: input.modelId, contextProfile: profile.id, fileMode: input.fileMode ?? 'code', range });
    return {
        prompt,
        stop: ['<|file_sep|>', '<|endoftext|>'],
        maxTokens,
        model: llamaModel,
        format: 'sweep',
        overflow: trimmed.overflow,
        prefill: trimmed.prefill,
        promptTokens,
        tokenMode,
        contextProfile: profile.id,
    };
}

/**
 * Собирает секции в training-format порядке: зона A (файлы) → зона B (псевдофайлы) → диффы → триада;
 * порядок жёстко закреплён потому что Sweep-модели обучались именно на нём.
 */
function buildSweepSections(input: BuildSweepPromptInput, trimmed: TrimmedSweepContext, range: string): string[] {
    const sections: string[] = [];

    if (trimmed.broadFileText) {
        sections.push(formatSweepCurrentFileBlock(input.filePath, trimmed.broadFileText));
    }
    sections.push(...formatSweepNeighborFileBlocks(trimmed.neighbors));
    sections.push(...formatSweepRelatedFileBlocks(trimmed.relatedFiles));

    if (trimmed.outline) {
        sections.push(`<|file_sep|>outline/${input.filePath}\n${trimmed.outline}`);
    }
    if (trimmed.diagnostics.length > 0) {
        sections.push(`<|file_sep|>diagnostics/${input.filePath}\n${formatSweepDiagnosticsLines(trimmed.diagnostics)}`);
    }
    for (const snippet of trimmed.outputSnippets) {
        sections.push(`<|file_sep|>output/${snippet.channel}\n${normalizeCrlf(snippet.text)}`);
    }

    sections.push(...formatSweepDiffBlocks(trimmed.recentEdits));

    const currentWindow = insertCursor(trimmed.windowText, trimmed.cursorOffset, '<|cursor|>');
    sections.push(`<|file_sep|>original/${input.filePath}:${range}\n${trimmed.originalWindowText}`);
    sections.push(`<|file_sep|>current/${input.filePath}:${range}\n${currentWindow}`);
    // updated/ всегда последний блок; модель генерирует continuation после него.
    sections.push(`<|file_sep|>updated/${input.filePath}:${range}\n${trimmed.prefill}`);

    if (process.env.NODE_ENV === 'development') {
        const finalTriad = new Array<string>(3);
        for (let i = 0; i < 3; i++) {
            const section = sections[sections.length - 3 + i];
            const newline = section.indexOf('\n');
            finalTriad[i] = newline >= 0 ? section.slice(0, newline) : section;
        }
        LOG.debug('Sweep prompt sections ordered', {
            total: sections.length,
            finalTriad,
        });
    }
    return sections;
}

/**
 * Вставляет маркер `<|cursor|>` в текст current/ блока без изменения окружающего текста;
 * нужен чтобы модель знала точную позицию курсора при генерации updated/ блока.
 */
function insertCursor(text: string, offset: number, token: string): string {
    const safeOffset = Math.max(0, Math.min(offset, text.length));
    return `${text.slice(0, safeOffset)}${token}${text.slice(safeOffset)}`;
}

/**
 * Вычисляет строковый диапазон для заголовков original/current/updated блоков;
 * нужен чтобы модель видела абсолютные координаты окна в файле.
 */
function windowRange(startLine0: number, windowText: string): string {
    const start = startLine0 + 1;
    const end = startLine0 + lineCount(windowText);
    return `${start}:${end}`;
}

/**
 * Считает строки через LF-нормализацию чтобы диапазоны в заголовках блоков
 * совпадали с координатами Theia-документа независимо от платформы.
 */
function lineCount(text: string): number {
    let count = 1;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code === 13 /* \r */) {
            count++;
            if (text.charCodeAt(i + 1) === 10 /* \n */) {
                i++;
            }
        } else if (code === 10 /* \n */) {
            count++;
        }
    }
    return count;
}

/**
 * Клампит пользовательский объём правки внутри профиля, чтобы малые модели не переполняли окно вывода.
 */
function maxTokensForSweepVolume(volume: SweepEditVolume, profileMax: number): number {
    switch (volume) {
        case 'small':
            return Math.min(profileMax, 384);
        case 'large':
            return profileMax;
        default:
            return Math.min(profileMax, 768);
    }
}
