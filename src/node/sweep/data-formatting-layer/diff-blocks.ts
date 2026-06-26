import { RecentEdit } from '../../../common/edit-history-types';
import { SweepLogger } from '../../../common/sweep/logger';
import { splitLines } from '../../../common/text/crlf';

// Логгер форматировщика диффов; нужен для диагностики размера original/updated состояний перед вставкой в промпт.
const LOG = new SweepLogger('node:data-formatting:diff-blocks');

/**
 * Разделяет unified diff на состояния original и updated; нужен потому что Sweep-промпт требует
 * именно этот формат `{path}.diff` с секциями `original:` и `updated:` вместо стандартного unified diff.
 */
export function unifiedDiffToOriginalUpdated(diff: string): { original: string; updated: string } {
    const original: string[] = [];
    const updated: string[] = [];
    for (const line of splitLines(diff)) {
        if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('@@') || line.startsWith('Index: ') || line.startsWith('===')) {
            continue;
        }
        if (line.startsWith('-')) {
            original.push(line.slice(1));
        } else if (line.startsWith('+')) {
            updated.push(line.slice(1));
        } else if (line.startsWith(' ')) {
            original.push(line.slice(1));
            updated.push(line.slice(1));
        } else {
            original.push(line);
            updated.push(line);
        }
    }
    const result = { original: original.join('\n'), updated: updated.join('\n') };
    if (process.env.NODE_ENV === 'development') {
        LOG.debug('Sweep diff split into original/updated states', { originalChars: result.original.length, updatedChars: result.updated.length });
    }
    return result;
}

/**
 * Форматирует список RecentEdit-диффов в нативные Sweep `{path}.diff` блоки;
 * порядок хронологический чтобы модель видела историю правок от старых к новым.
 */
export function formatSweepDiffBlocks(edits: RecentEdit[]): string[] {
    const sorted = edits.slice().sort((a, b) => a.timestamp - b.timestamp);
    const blocks = new Array<string>(sorted.length);
    for (let i = 0; i < sorted.length; i++) {
        const edit = sorted[i];
        const { original, updated } = unifiedDiffToOriginalUpdated(edit.unifiedDiff);
        blocks[i] = `<|file_sep|>${edit.uri}.diff\noriginal:\n${original}\nupdated:\n${updated}`;
    }
    LOG.info('Sweep diff blocks formatted', { edits: edits.length, blocks: blocks.length });
    return blocks;
}
