import { injectable } from '@theia/core/shared/inversify';
import type { Neighbor } from '../../../common/embedding-types';
import type { FileMode } from '../../../common/mode-types';
import { SweepLogger } from '../../../common/sweep/logger';
import type { GraphQuerySignals, SweepFuzzyConfig, SweepGraphConfig, SweepRerankConfig } from '../../../common/sweep/types';
import { EmbeddingIndexServiceImpl } from '../../services/embedding-index-service';
import { SweepFuzzyChannel } from './fuzzy/sweep-fuzzy-channel';
import { SweepGraphChannel } from './graph/sweep-graph-channel';
import { mergeNeighborChannels } from './merge';
import { buildSweepRerankQuery, clipRerankDocument, isAmbiguous, looksBroken, SweepRerankerClient } from './rerank/sweep-reranker-client';

/** Warmup timeout даёт холодному reranker server шанс загрузить модель вне hot path. */
const RERANK_WARMUP_TIMEOUT_MS = 15000;

/** Логгер retrieval orchestrator показывает вклад каналов до prompt trimming. */
const LOG = new SweepLogger('node:retrieval-orchestrator');

export interface SweepRetrievalConfig {
    rerank: SweepRerankConfig;
    graph: SweepGraphConfig;
    fuzzy: SweepFuzzyConfig;
}

export interface OrchestratorInput {
    query: string;
    fileMode: FileMode;
    signals: GraphQuerySignals;
    fuzzySymbols: string[];
    topN: number;
    signal?: AbortSignal;
}

/** Sweep retrieval orchestrator объединяет S/G/F каналы, общий RRF merge и fail-open rerank. */
@injectable()
export class SweepRetrievalOrchestrator {
    private readonly reranker = new SweepRerankerClient();
    private rerankerBroken = false;
    private readonly embedding: EmbeddingIndexServiceImpl;
    private readonly graph: SweepGraphChannel;
    private readonly fuzzy: SweepFuzzyChannel;

    /** Канал S остаётся существующим EmbeddingIndexServiceImpl; G/F инжектятся как Sweep-local services. */
    constructor(
        embedding: EmbeddingIndexServiceImpl,
        graph: SweepGraphChannel,
        fuzzy: SweepFuzzyChannel,
    ) {
        this.embedding = embedding;
        this.graph = graph;
        this.fuzzy = fuzzy;
    }

    /** Сбрасывает broken-state и прогревает reranker только при включённой rerank настройке. */
    async configure(config: SweepRerankConfig): Promise<void> {
        this.rerankerBroken = false;
        if (config.enabled) {
            await this.warmupReranker(config);
        }
    }

    /** Выполняет S+G+F retrieval для code mode и S-only для prose, затем merge и optional rerank. */
    async retrieve(input: OrchestratorInput, config: SweepRetrievalConfig): Promise<Neighbor[]> {
        const finalTopN = Math.max(1, Math.min(config.rerank.finalTopN, input.topN));
        const poolN = Math.max(finalTopN, config.rerank.candidatePoolN);
        const channels: Neighbor[][] = [];
        const semantic = await this.retrieveSemantic(input.query, poolN, input.signal);
        channels.push(semantic);
        if (input.fileMode === 'code' && config.graph.enabled) {
            channels.push(this.graph.retrieve(input.signals, poolN));
        }
        if (input.fileMode === 'code' && config.fuzzy.enabled) {
            channels.push(this.fuzzy.retrieve(input.fuzzySymbols, poolN));
        }
        const merged = mergeNeighborChannels(channels, poolN);
        if (!config.rerank.enabled || this.rerankerBroken || !isAmbiguous(merged, config.rerank.ambiguityMargin, finalTopN)) {
            return merged.slice(0, finalTopN);
        }
        try {
            return await this.rerankNeighbors(merged, input.query, config.rerank, finalTopN, input.signal);
        } catch (error) {
            LOG.warn('Sweep rerank failed, falling back to merged order', { error: error instanceof Error ? error.message : String(error) });
            return merged.slice(0, finalTopN);
        }
    }

    /** Выполняет существующий semantic embedding retrieval канал S без изменений общего embedding-module. */
    private async retrieveSemantic(query: string, topN: number, signal?: AbortSignal): Promise<Neighbor[]> {
        LOG.info('Sweep semantic retrieval starting', { queryChars: query.length, topN });
        const neighbors = await this.embedding.retrieve(query, topN, signal);
        const files = new Array<string>(neighbors.length);
        for (let i = 0; i < neighbors.length; i++) {
            files[i] = neighbors[i].filePath;
        }
        LOG.info('Sweep semantic retrieval completed', { neighbors: neighbors.length, files });
        return neighbors;
    }

    /** Запускает Qwen3 rerank над prefix-срезом merged candidates и сохраняет index mapping. */
    private async rerankNeighbors(merged: Neighbor[], baseQuery: string, config: SweepRerankConfig, finalTopN: number, signal?: AbortSignal): Promise<Neighbor[]> {
        const candidateCount = Math.min(Math.max(finalTopN, config.rerankTopN), merged.length);
        const candidates = merged.slice(0, candidateCount);
        const documents = new Array<string>(candidates.length);
        for (let i = 0; i < candidates.length; i++) {
            documents[i] = clipRerankDocument(candidates[i].text, config.maxDocChars);
        }
        const ranked = await this.reranker.rerank({
            baseUrl: config.llamaUrl,
            model: config.model,
            query: buildSweepRerankQuery(config.instruction, baseQuery),
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
        let fallbackScore = selected.length > 0 ? selected[selected.length - 1].score : 0;
        for (let i = 0; i < candidates.length && selected.length < finalTopN; i++) {
            if (!used.has(i)) {
                fallbackScore -= 1;
                selected.push({ ...candidates[i], score: fallbackScore });
            }
        }
        LOG.info('Sweep rerank completed', { inputCandidates: candidates.length, selected: selected.length });
        return selected;
    }

    /** Прогревает reranker server при включённом rerank, не ломая configure при сетевой ошибке. */
    private async warmupReranker(config: SweepRerankConfig): Promise<void> {
        try {
            const ranked = await this.reranker.rerank({
                baseUrl: config.llamaUrl,
                model: config.model,
                query: buildSweepRerankQuery(config.instruction, 'warmup'),
                documents: ['function warmup() { return true; }'],
                topN: 1,
                timeoutMs: Math.max(config.timeoutMs, RERANK_WARMUP_TIMEOUT_MS),
            });
            if (looksBroken(ranked)) {
                this.rerankerBroken = true;
                LOG.warn('Sweep rerank warmup returned degenerate scores');
            }
        } catch (error) {
            LOG.warn('Sweep rerank warmup failed', { error: error instanceof Error ? error.message : String(error) });
        }
    }
}
