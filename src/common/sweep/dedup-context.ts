import type { Neighbor } from '../embedding-types';
import type { SweepRelatedFile } from './types';

/** Вход дедупликации Sweep-контекста перед token-budget trimming. */
export interface DedupContextInput {
    currentFilePath: string;
    neighbors: Neighbor[];
    relatedFiles: SweepRelatedFile[];
}

/** Счётчики отброшенных блоков нужны для telemetry и проверки качества retrieval. */
export interface DedupContextDropped {
    neighborsByCurrentFile: number;
    neighborsByRelated: number;
    relatedByCurrentFile: number;
    neighborsByDup: number;
}

/** Результат дедупликации сохраняет свежие related-файлы и удаляет устаревшие RAG-дубли. */
export interface DedupContextResult {
    neighbors: Neighbor[];
    relatedFiles: SweepRelatedFile[];
    dropped: DedupContextDropped;
}

/** Исключает текущий файл и RAG-дубли до trimming, чтобы бюджет считал только полезный контекст. */
export function dedupeContextFiles(input: DedupContextInput): DedupContextResult {
    const current = normalizeContextPath(input.currentFilePath);
    const relatedFiles: SweepRelatedFile[] = [];
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

/** Нормализует пути из RAG/LSP/SCM к единому виду для стабильного сравнения источников. */
function normalizeContextPath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}
