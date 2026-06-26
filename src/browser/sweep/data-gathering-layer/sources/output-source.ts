import { OutputChannelManager } from '@theia/output/lib/browser/output-channel';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import { SweepLogger } from '../../../../common/sweep/logger';
import { extractRelevantOutput } from '../../../../common/sweep/output-filter';
import { SweepOutputSnippet } from '../../../../common/sweep/types';

// Ограничение числа каналов предотвращает перегрузку промпта нерелевантным выводом при большом числе открытых каналов.
const MAX_CHANNELS = 3;
// Логгер источника output; нужен для диагностики того, какие каналы попали в Sweep-промпт.
const LOG = new SweepLogger('browser:data-gathering:output-source');

/** Извлекает отфильтрованные фрагменты из Output-каналов Theia для output/ псевдофайлов Sweep-промпта. */
@injectable()
export class OutputSource {
    // Менеджер Output-каналов Theia; нужен для обхода открытых каналов в порядке приоритета.
    @inject(OutputChannelManager) protected readonly channels!: OutputChannelManager;

    /**
     * Собирает отфильтрованные Output-сниппеты начиная с активного канала, чтобы
     * модель видела актуальные ошибки сборки и тестов без избыточного шума.
     */
    collect(): SweepOutputSnippet[] {
        const seen = new Set<string>();
        const snippets: SweepOutputSnippet[] = [];
        const visit = (channel: NonNullable<ReturnType<OutputChannelManager['getChannels']>[number]>): boolean => {
            if (seen.has(channel.name)) {
                return false;
            }
            seen.add(channel.name);
            const model = monaco.editor.getModel(monaco.Uri.parse(channel.uri.toString()));
            const text = model?.getValue() ?? '';
            const snippet = extractRelevantOutput(text);
            if (snippet) {
                snippets.push({ channel: channel.name, text: snippet });
            }
            return snippets.length >= MAX_CHANNELS;
        };
        const selected = this.channels.selectedChannel;
        if (selected && visit(selected)) {
            LOG.info('Sweep output snippets collected', { channelsSeen: seen.size, snippets: snippets.length });
            return snippets;
        }
        for (const channel of this.channels.getChannels()) {
            if (visit(channel)) {
                break;
            }
        }
        LOG.info('Sweep output snippets collected', { channelsSeen: seen.size, snippets: snippets.length });
        return snippets;
    }
}
