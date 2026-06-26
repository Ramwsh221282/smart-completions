import type { PositionDTO, RangeDTO, TextEditDTO } from '../../../common/editor-dto';
import { normalizeCrlf } from '../../../common/text/crlf';
import { ZetaLogger } from '../../../common/zeta21/logger';
import type { ZetaEditableRegion } from '../../../common/zeta21/types';
import { zetaRejectReason } from './reject-gates';

// Логгер парсера нужен для диагностики marker pairs, объёма чистого ответа и финальных диапазонов multi-edit результата.
const LOG = new ZetaLogger('node:model-call:zeta-response-parser');

// Шумовые токены вырезаются одной регуляркой за проход, чтобы служебные FIM-маркеры не протекали в пользовательские правки.
const ZETA_NOISE = /<\|user_cursor\|>|<\[fim-(?:suffix|prefix|middle)\]>/g;

// REGION_RE захватывает содержимое между marker_N и marker_N+1; lastIndex сбрасывается перед каждым прогоном.
const REGION_RE = /<\|marker_(\d+)\|>([\s\S]*?)<\|marker_(\d+)\|>/g;

// Вход парсинга объединяет сырой ответ модели с исходным окном и регионами, чтобы parser мог вернуть точные TextEditDTO.
export interface ParseZetaCompletionInput {
    rawText: string;
    windowText: string;
    windowStart: PositionDTO;
    regions: ZetaEditableRegion[];
    stopTokens: string[];
}

// Результат парсинга содержит edits готовые для View Zone renderer и first edit coordinates для jump/accept UX.
export interface ParsedZetaCompletion {
    edits: TextEditDTO[];
    primaryRange: RangeDTO | null;
    jumpTo: PositionDTO | null;
    status: 'edit' | 'no-edit' | 'rejected';
    rejectReason: string | null;
}

/** Парсит multi-region ответ Zeta: для каждого marker-pair строит TextEditDTO и отбрасывает регионы которые выглядят как drift. */
export function parseZetaCompletion(input: ParseZetaCompletionInput): ParsedZetaCompletion {
    const cleaned = cutAtStop(normalizeCrlf(input.rawText), input.stopTokens);
    const byMarker = extractRegionContents(cleaned);
    if (byMarker.size === 0) {
        LOG.info('Zeta response parsed as no-op because no valid marker pairs were found');
        return { edits: [], primaryRange: null, jumpTo: null, status: 'no-edit', rejectReason: null };
    }
    const edits: TextEditDTO[] = [];
    let primaryRange: RangeDTO | null = null;
    let rejected = 0;
    for (let i = 0; i < input.regions.length; i++) {
        const region = input.regions[i];
        const revised = byMarker.get(region.markerIndex);
        if (revised === undefined) {
            continue;
        }
        const cleanRevised = stripMarkerNoise(revised);
        const original = input.windowText.slice(region.startOffset, region.endOffset);
        if (cleanRevised === original) {
            continue;
        }
        const rejectReason = zetaRejectReason(original, cleanRevised);
        if (rejectReason !== undefined) {
            rejected++;
            continue;
        }
        const edit = buildEdit(input.windowText, input.windowStart, region, cleanRevised);
        edits.push(edit);
        if (primaryRange === null) {
            primaryRange = edit.range;
        }
    }
    LOG.info('Zeta response parsed', { markerPairs: byMarker.size, edits: edits.length, rejected });
    if (edits.length === 0) {
        return { edits: [], primaryRange: null, jumpTo: null, status: rejected > 0 ? 'rejected' : 'no-edit', rejectReason: rejected > 0 ? 'region-rejected' : null };
    }
    return { edits, primaryRange, jumpTo: primaryRange ? primaryRange.start : null, status: 'edit', rejectReason: null };
}

function extractRegionContents(text: string): Map<number, string> {
    REGION_RE.lastIndex = 0;
    const out = new Map<number, string>();
    for (let match = REGION_RE.exec(text); match; match = REGION_RE.exec(text)) {
        const open = Number(match[1]);
        const close = Number(match[3]);
        if (close === open + 1) {
            out.set(open, match[2]);
        }
    }
    return out;
}

function cutAtStop(text: string, stopTokens: string[]): string {
    let cut = text.length;
    for (let i = 0; i < stopTokens.length; i++) {
        const index = text.indexOf(stopTokens[i]);
        if (index !== -1 && index < cut) {
            cut = index;
        }
    }
    return text.slice(0, cut);
}

function stripMarkerNoise(text: string): string {
    ZETA_NOISE.lastIndex = 0;
    return text.replace(ZETA_NOISE, '').replace(/^\n/, '').trimEnd();
}

function buildEdit(windowText: string, windowStart: PositionDTO, region: ZetaEditableRegion, newText: string): TextEditDTO {
    return {
        range: {
            start: offsetToPosition(windowText, region.startOffset, windowStart),
            end: offsetToPosition(windowText, region.endOffset, windowStart),
        },
        newText,
    };
}

function offsetToPosition(text: string, offset: number, windowStart: PositionDTO): PositionDTO {
    const safeOffset = Math.max(0, Math.min(offset, text.length));
    let line = windowStart.line;
    let character = windowStart.character;
    for (let i = 0; i < safeOffset; i++) {
        if (text.charCodeAt(i) === 10) {
            line++;
            character = 0;
        } else {
            character++;
        }
    }
    return { line, character };
}
