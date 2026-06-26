import { Neighbor } from '../../../common/embedding-types';
import { SweepLogger } from '../../../common/sweep/logger';
import { SweepRelatedFile } from '../../../common/sweep/types';
import { normalizeCrlf } from '../../../common/text/crlf';

// Логгер форматировщика файловых блоков; нужен для диагностики сколько блоков попало в зону A промпта.
const LOG = new SweepLogger('node:data-formatting:file-blocks');

/** Форматирует широкий блок текущего файла первым, потому что Sweep v2 обучался видеть локальный file chunk до retrieval. */
export function formatSweepCurrentFileBlock(filePath: string, text: string): string {
    return `<|file_sep|>${filePath}\n${normalizeCrlf(text)}`;
}

/**
 * Форматирует RAG-соседей из embedding-retrieval в нативные `<|file_sep|>{path}` блоки;
 * нативный формат используется вместо legacy `context/*` потому что на нём обучена Sweep-модель.
 */
export function formatSweepNeighborFileBlocks(neighbors: Neighbor[]): string[] {
    const blocks = new Array<string>(neighbors.length);
    for (let i = 0; i < neighbors.length; i++) {
        const neighbor = neighbors[i];
        blocks[i] = `<|file_sep|>${neighbor.filePath}\n${normalizeCrlf(neighbor.text)}`;
    }
    LOG.info('Sweep RAG file blocks formatted', { neighbors: neighbors.length, blocks: blocks.length });
    return blocks;
}

/**
 * Форматирует related-файлы от фронтенд-источников в нативные `<|file_sep|>{path}` блоки;
 * те же блоки что и у RAG-соседей — модель видит единый формат независимо от источника файла.
 */
export function formatSweepRelatedFileBlocks(relatedFiles: SweepRelatedFile[]): string[] {
    const blocks = new Array<string>(relatedFiles.length);
    for (let i = 0; i < relatedFiles.length; i++) {
        const related = relatedFiles[i];
        blocks[i] = `<|file_sep|>${related.filePath}\n${normalizeCrlf(related.content)}`;
    }
    LOG.info('Sweep related file blocks formatted', { relatedFiles: relatedFiles.length, blocks: blocks.length });
    return blocks;
}
