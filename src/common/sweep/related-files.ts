import { SweepLogger } from './logger';
import { SweepRelatedFile } from './types';

// Логгер модуля ранжирования; нужен для диагностики сколько кандидатов дошло до финального списка и почему.
const LOG = new SweepLogger('common:related-files');

// Кандидат на related-файл до дедупликации и ранжирования; score задаётся источником для приоритизации.
export interface RelatedCandidate {
    filePath: string;
    content: string;
    startLine?: number;
    endLine?: number;
    score?: number;
}

/**
 * Дедуплицирует и ранжирует кандидатов от всех источников контекста перед тем как они попадут
 * в Sweep file-блоки промпта; ограничивает число файлов topN чтобы не превысить бюджет токенов.
 */
export function dedupeRankRelated(candidates: RelatedCandidate[], topN: number): SweepRelatedFile[] {
    if (topN <= 0) {
        LOG.info('Sweep related-file ranking skipped because topN is disabled', { candidates: candidates.length, topN });
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

    // Сортировка по убыванию score; при равном score сохраняется порядок источников (LSP > search > SCM).
    indexed.sort((a, b) => {
        const sa = a.candidate.score ?? 0;
        const sb = b.candidate.score ?? 0;
        return sb - sa || a.index - b.index;
    });

    const out: SweepRelatedFile[] = [];
    for (const { candidate } of indexed) {
        // Ключ path:start:end предотвращает дубликаты одного файлового фрагмента от разных источников.
        const key = `${candidate.filePath}:${candidate.startLine ?? ''}:${candidate.endLine ?? ''}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push({ filePath: candidate.filePath, content: candidate.content });
        if (out.length >= topN) {
            break;
        }
    }
    LOG.info('Sweep related files ranked', { candidates: candidates.length, nonEmpty: indexed.length, selected: out.length, topN });
    return out;
}
