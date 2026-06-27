import { injectable, multiInject } from '@theia/core/shared/inversify';
import type { Neighbor } from '../../../common/embedding-types';
import type { FimRetrievalConfig } from '../../../common/fim-types';
import { FimLogger } from '../../../common/fim/logger';
import type { FileMode } from '../../../common/mode-types';
import type { GraphQuerySignals } from '../../../common/sweep/types';
import { mergeNeighborChannels } from './merge';
import { FimRetrievalChannel, type RetrievalChannel, type RetrievalChannelInput } from './fim-retrieval-channel';
import { buildFimRerankQuery, clipRerankDocument, FimRerankerClient, looksBroken } from './rerank/fim-reranker-client';

const RERANK_WARMUP_TIMEOUT_MS = 15000;
const LOG = new FimLogger('node:retrieval-orchestrator');

export interface OrchestratorInput {
    query: string;
    fileMode: FileMode;
    signals: GraphQuerySignals;
    fuzzySymbols: string[];
    topN: number;
    signal?: AbortSignal;
}

@injectable()
export class FimRetrievalOrchestrator {
    private readonly reranker = new FimRerankerClient();
    // После вырожденных score-ов reranker считается broken до следующего configure, чтобы не штрафовать каждый hot request повторным fail-open.
    private rerankerBroken = false;
    private readonly channels: RetrievalChannel[];

    constructor(@multiInject(FimRetrievalChannel) channels: RetrievalChannel[]) {
        this.channels = channels;
    }

    async configure(config: FimRetrievalConfig['rerank']): Promise<void> {
        this.rerankerBroken = false;
        if (config.enabled) {
            await this.warmupReranker(config);
        }
    }

    async retrieve(input: OrchestratorInput, config: FimRetrievalConfig): Promise<Neighbor[]> {
        const finalTopN = Math.max(1, Math.min(config.rerank.finalTopN, input.topN));
        const poolN = Math.max(finalTopN, config.rerank.candidatePoolN);
        const channelInput: RetrievalChannelInput = {
            query: input.query,
            signals: input.signals,
            fuzzySymbols: input.fuzzySymbols,
            signal: input.signal,
        };
        const lists: Neighbor[][] = [];
        for (let i = 0; i < this.channels.length; i++) {
            const channel = this.channels[i];
            if (channel.codeOnly && input.fileMode !== 'code') {
                continue;
            }
            if (!channel.isEnabled(config)) {
                continue;
            }
            lists.push(await channel.retrieve(channelInput, poolN));
        }
        const merged = mergeNeighborChannels(lists, poolN);
        if (!config.rerank.enabled || this.rerankerBroken) {
            return merged.slice(0, finalTopN);
        }
        try {
            return await this.rerankNeighbors(merged, input.query, config.rerank, finalTopN, input.signal);
        } catch (error) {
            LOG.warn('FIM rerank failed, falling back to merged order', { error: error instanceof Error ? error.message : String(error) });
            return merged.slice(0, finalTopN);
        }
    }

    private async rerankNeighbors(merged: Neighbor[], baseQuery: string, config: FimRetrievalConfig['rerank'], finalTopN: number, signal?: AbortSignal): Promise<Neighbor[]> {
        const candidateCount = Math.min(Math.max(finalTopN, config.rerankTopN), merged.length);
        const candidates = merged.slice(0, candidateCount);
        const documents = new Array<string>(candidates.length);
        for (let i = 0; i < candidates.length; i++) {
            documents[i] = clipRerankDocument(candidates[i].text, config.maxDocChars);
        }
        const ranked = await this.reranker.rerank({
            baseUrl: config.llamaUrl,
            model: config.model,
            query: buildFimRerankQuery(config.instruction, baseQuery),
            documents,
            topN: documents.length,
            timeoutMs: config.timeoutMs,
            signal,
        });
        if (looksBroken(ranked)) {
            this.rerankerBroken = true;
            throw new Error('reranker returned degenerate scores');
        }
        const selected: Neighbor[] = [];
        const used = new Set<number>();
        for (let i = 0; i < ranked.length && selected.length < finalTopN; i++) {
            const index = ranked[i].index;
            if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
                throw new Error(`reranker returned invalid index ${index}`);
            }
            if (!used.has(index)) {
                used.add(index);
                selected.push({ ...candidates[index], score: ranked[i].score });
            }
        }
        // Если reranker вернул меньше top-N валидных индексов, добираем остаток merged-порядком, чтобы пайплайн оставался fail-open.
        let fallbackScore = selected.length > 0 ? selected[selected.length - 1].score : 0;
        for (let i = 0; i < candidates.length && selected.length < finalTopN; i++) {
            if (!used.has(i)) {
                fallbackScore -= 1;
                selected.push({ ...candidates[i], score: fallbackScore });
            }
        }
        LOG.info('FIM rerank completed', { inputCandidates: candidates.length, selected: selected.length });
        return selected;
    }

    private async warmupReranker(config: FimRetrievalConfig['rerank']): Promise<void> {
        try {
            const ranked = await this.reranker.rerank({
                baseUrl: config.llamaUrl,
                model: config.model,
                query: buildFimRerankQuery(config.instruction, 'warmup'),
                documents: ['function warmup() { return true; }'],
                topN: 1,
                timeoutMs: Math.max(config.timeoutMs, RERANK_WARMUP_TIMEOUT_MS),
            });
            if (looksBroken(ranked)) {
                this.rerankerBroken = true;
                LOG.warn('FIM rerank warmup returned degenerate scores');
            }
        } catch (error) {
            LOG.warn('FIM rerank warmup failed', { error: error instanceof Error ? error.message : String(error) });
        }
    }
}
