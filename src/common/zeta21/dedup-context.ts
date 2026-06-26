import type { Neighbor } from '../embedding-types';
import type { ZetaRelatedFile } from './types';

// Вход дедупликации zeta21-контекста объединяет frontend related и backend neighbors до token-budget trimming.
export interface DedupContextInput {
    currentFilePath: string;
    neighbors: Neighbor[];
    relatedFiles: ZetaRelatedFile[];
}

// Счётчики отброшенных блоков помогают понять почему retrieval-соседи не дошли до финального prompt.
export interface DedupContextDropped {
    neighborsByCurrentFile: number;
    neighborsByRelated: number;
    relatedByCurrentFile: number;
    neighborsByDup: number;
}

// Результат дедупликации сохраняет свежие related-файлы и удаляет дубли текущего файла и повторные RAG-соседи.
export interface DedupContextResult {
    neighbors: Neighbor[];
    relatedFiles: ZetaRelatedFile[];
    dropped: DedupContextDropped;
}

/** Исключает текущий файл и RAG-дубли до trimming, чтобы zeta21-бюджет расходовался только на внешний контекст. */
export function dedupeContextFiles(input: DedupContextInput): DedupContextResult {
    const current = normalizeContextPath(input.currentFilePath);
    const relatedFiles: ZetaRelatedFile[] = [];
    const relatedPaths = new Set<string>();
    let relatedByCurrentFile = 0;

    for (let i = 0; i < input.relatedFiles.length; i++) {
        const related = input.relatedFiles[i];
        const relatedPath = normalizeContextPath(related.filePath);
        if (relatedPath === current) {
            relatedByCurrentFile++;
            continue;
        }
        relatedFiles.push(related);
        relatedPaths.add(relatedPath);
    }

    const neighbors: Neighbor[] = [];
    const seen = new Set<string>();
    let neighborsByCurrentFile = 0;
    let neighborsByRelated = 0;
    let neighborsByDup = 0;

    for (let i = 0; i < input.neighbors.length; i++) {
        const neighbor = input.neighbors[i];
        const neighborPath = normalizeContextPath(neighbor.filePath);
        if (neighborPath === current) {
            neighborsByCurrentFile++;
            continue;
        }
        if (relatedPaths.has(neighborPath)) {
            neighborsByRelated++;
            continue;
        }
        const key = `${neighborPath}:${neighbor.startLine}:${neighbor.endLine}`;
        if (seen.has(key)) {
            neighborsByDup++;
            continue;
        }
        seen.add(key);
        neighbors.push(neighbor);
    }

    return {
        neighbors,
        relatedFiles,
        dropped: { neighborsByCurrentFile, neighborsByRelated, relatedByCurrentFile, neighborsByDup },
    };
}

function normalizeContextPath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}
