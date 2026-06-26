import { ZetaLogger } from './logger';
import type { ZetaRelatedFile } from './types';

// Логгер ранжирования related-файлов нужен чтобы видеть сколько кандидатов реально дошло до Zeta prefix-зоны.
const LOG = new ZetaLogger('common:related-files');

// Кандидат на related-файл до дедупликации и обрезки; score задаётся источником для tie-break ранжирования.
export interface RelatedCandidate {
    filePath: string;
    content: string;
    startLine?: number;
    endLine?: number;
    score?: number;
}

/** Дедуплицирует и ранжирует related-кандидатов до topN, чтобы Zeta prefix-зона тратила бюджет только на полезные файлы. */
export function dedupeRankRelated(candidates: RelatedCandidate[], topN: number): ZetaRelatedFile[] {
    if (topN <= 0) {
        LOG.info('Zeta related-file ranking skipped because topN is disabled', { candidates: candidates.length, topN });
        return [];
    }
    const seen = new Set<string>();
    const indexed: Array<{ candidate: RelatedCandidate; index: number }> = [];
    for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        if (candidate.content.trim().length > 0) {
            indexed.push({ candidate, index });
        }
    }
    indexed.sort((a, b) => {
        const scoreA = a.candidate.score ?? 0;
        const scoreB = b.candidate.score ?? 0;
        return scoreB - scoreA || a.index - b.index;
    });

    const out: ZetaRelatedFile[] = [];
    for (let i = 0; i < indexed.length; i++) {
        const candidate = indexed[i].candidate;
        const key = `${candidate.filePath}:${candidate.startLine ?? ''}:${candidate.endLine ?? ''}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push({ filePath: candidate.filePath, content: candidate.content, score: candidate.score });
        if (out.length >= topN) {
            break;
        }
    }
    LOG.info('Zeta related files ranked', { candidates: candidates.length, nonEmpty: indexed.length, selected: out.length, topN });
    return out;
}
