import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CancellationToken, Disposable } from '@theia/core/lib/common';
import { inject, injectable } from '@theia/core/shared/inversify';
import type { Neighbor } from '../../common/embedding-types';
import type { TextEditDTO } from '../../common/editor-dto';
import { buildZetaRetrievalQuery } from '../../common/zeta21/retrieval-queries';
import { extractZetaSignals } from '../../common/zeta21/signals';
import { ZetaLogger } from '../../common/zeta21/logger';
import { ZETA_PROFILE } from '../../common/zeta21/profiles';
import type { ZetaConfig, ZetaRequest, ZetaResponse } from '../../common/zeta21/types';
import { normalizeCrlf } from '../../common/text/crlf';
import { EmbeddingIndexServiceImpl } from '../services/embedding-index-service';
import { buildEditHistoryBlock } from './data-formatting-layer/edit-history-block';
import { renderRelatedExcerpts } from './data-formatting-layer/excerpt-renderer';
import { trimZetaContext } from './data-formatting-layer/context-trimmer';
import { LlamaZetaClient } from './model-call-layer/llama-zeta-client';
import { parseZetaCompletion } from './model-call-layer/zeta-response-parser';
import { buildZetaPrompt } from './prompt-creating-layer/zeta-prompt-builder';
import { ZetaRetrievalOrchestrator } from './retrieval/zeta-retrieval-orchestrator';
import { QwenTokenCounter } from './token-budget/token-counter';

// Логгер backend orchestrator покрывает весь zeta21 цикл: retrieval -> prompt -> completion -> parse.
const LOG = new ZetaLogger('node:backend-service');

/** Оркестрирует полный цикл zeta21-предсказания через отдельный backend path, не смешивая его с legacy NES routing. */
@injectable()
export class ZetaBackendService {
    @inject(EmbeddingIndexServiceImpl) private readonly embedding!: EmbeddingIndexServiceImpl;
    @inject(ZetaRetrievalOrchestrator) private readonly retrieval!: ZetaRetrievalOrchestrator;

    private config: ZetaConfig = defaultZetaConfig();
    private readonly client = new LlamaZetaClient();
    private readonly tokenCounter = new QwenTokenCounter();

    /** Принимает новый конфиг от фронтенда и прогревает tokenizer/reranker заранее, чтобы hot path оставался коротким. */
    async configure(config: ZetaConfig): Promise<void> {
        this.config = {
            ...config,
            contextSize: Math.max(1024, Math.min(config.contextSize, ZETA_PROFILE.contextTokens)),
        };
        await this.tokenCounter.ensureReady();
        await this.retrieval.configure(this.config.rerank);
        LOG.info('Zeta backend configured', {
            llamaUrl: this.config.llamaUrl,
            requestModelName: this.config.requestModelName,
            contextSize: this.config.contextSize,
            ragEnabled: this.config.ragEnabled,
        });
    }

    /** Выполняет одно zeta21-предсказание: retrieval -> excerpts -> trim -> prompt -> llama.cpp -> multi-region parse. */
    async predict(request: ZetaRequest, token?: CancellationToken): Promise<ZetaResponse> {
        const startedAt = Date.now();
        const skipReason = this.predictSkipReason(request, token);
        if (skipReason !== undefined) {
            LOG.info('Zeta prediction skipped', { reason: skipReason });
            return this.emptyResponse();
        }
        const abort = bridgeCancellation(token);
        try {
            const normalized = this.normalizeRequest(request);
            const neighbors = await this.loadNeighbors(request, normalized.windowText, abort.signal);
            const relatedFiles = await this.loadRelatedFiles(request, neighbors, normalized.currentFilePath);
            const trimmed = this.trimRequestContext(request, normalized, relatedFiles);
            if (trimmed.overflow) {
                LOG.warn('Zeta prediction skipped because prompt overflowed', { requestId: request.requestId });
                return this.emptyResponse();
            }
            const built = this.buildPrompt(normalized.currentFilePath, trimmed);
            const rawText = await this.completePrompt(built, abort.signal);
            return this.parsePrediction(request, normalized.windowText, trimmed, built.stop, rawText, startedAt);
        } catch (error) {
            if (abort.signal.aborted || isAbortError(error)) {
                LOG.info('Zeta prediction cancelled', { requestId: request.requestId });
                return this.emptyResponse();
            }
            LOG.error('Zeta prediction failed', { requestId: request.requestId, error: error instanceof Error ? error.message : String(error) });
            return this.emptyResponse();
        } finally {
            abort.dispose();
        }
    }

    private predictSkipReason(request: ZetaRequest, token?: CancellationToken): 'no recent edits' | 'cancelled' | undefined {
        if (request.recentEdits.length === 0) {
            return 'no recent edits';
        }
        return token?.isCancellationRequested ? 'cancelled' : undefined;
    }

    private normalizeRequest(request: ZetaRequest): NormalizedZetaRequest {
        return {
            windowText: normalizeCrlf(request.windowText),
            prefixText: normalizeCrlf(request.prefixText),
            suffixText: normalizeCrlf(request.suffixText),
            currentFilePath: this.filePathForUri(request.uri),
        };
    }

    private async loadNeighbors(request: ZetaRequest, windowText: string, signal?: AbortSignal): Promise<Neighbor[]> {
        if (!this.config.ragEnabled) {
            return [];
        }
        return this.retrieveNeighbors(request, windowText, signal);
    }

    private async loadRelatedFiles(request: ZetaRequest, neighbors: Neighbor[], currentFilePath: string) {
        return renderRelatedExcerpts(request.relatedFiles, neighbors, currentFilePath);
    }

    private trimRequestContext(request: ZetaRequest, normalized: NormalizedZetaRequest, relatedFiles: Awaited<ReturnType<typeof renderRelatedExcerpts>>) {
        return trimZetaContext({
            profile: ZETA_PROFILE,
            contextSize: this.config.contextSize,
            prefixText: normalized.prefixText,
            windowText: normalized.windowText,
            suffixText: normalized.suffixText,
            cursorOffset: request.cursorOffset,
            regions: request.regions,
            recentEdits: this.recentEditsForPrompt(request.recentEdits),
            relatedFiles,
            tokenCounter: this.tokenCounter,
        }, ZETA_PROFILE.maxOutputTokens);
    }

    private buildPrompt(currentFilePath: string, trimmed: ReturnType<typeof trimZetaContext>) {
        return buildZetaPrompt({
            targetPath: currentFilePath,
            prefixBeforeRegion: trimmed.prefixBeforeRegion,
            windowText: trimmed.windowText,
            suffixText: trimmed.suffixText,
            cursorOffset: trimmed.cursorOffset,
            regions: trimmed.regions,
            relatedFiles: trimmed.relatedFiles,
            editHistoryBlock: buildEditHistoryBlock(trimmed.recentEdits),
        });
    }

    private async completePrompt(built: ReturnType<typeof buildZetaPrompt>, signal?: AbortSignal): Promise<string> {
        return this.client.complete({
            baseUrl: this.config.llamaUrl,
            model: this.config.requestModelName,
            prompt: built.prompt,
            stop: built.stop,
            maxTokens: ZETA_PROFILE.maxOutputTokens,
            temperature: ZETA_PROFILE.temperature,
            cachePrompt: true,
            seed: 0,
            signal,
        });
    }

    private parsePrediction(
        request: ZetaRequest,
        windowText: string,
        trimmed: ReturnType<typeof trimZetaContext>,
        stopTokens: string[],
        rawText: string,
        startedAt: number,
    ): ZetaResponse {
        const parsed = parseZetaCompletion({
            rawText,
            windowText: trimmed.windowText,
            windowStart: shiftWindowStart(windowText, request.windowStart, trimmed.windowOffset),
            regions: trimmed.regions,
            stopTokens,
        });
        LOG.info('Zeta prediction completed', {
            requestId: request.requestId,
            durationMs: Date.now() - startedAt,
            edits: parsed.edits.length,
            status: parsed.status,
        });
        if (parsed.edits.length === 0) {
            return this.emptyResponse();
        }
        return this.successResponse(parsed.edits, parsed.primaryRange, parsed.jumpTo);
    }

    /** Выполняет RAG-retrieval по edit-сигналам и пропускает embedding-вызов, если query пустой или topN выключен. */
    private async retrieveNeighbors(request: ZetaRequest, windowText: string, signal?: AbortSignal): Promise<Neighbor[]> {
        const query = buildZetaRetrievalQuery({
            recentEdits: request.recentEdits,
            windowText,
            cursorOffset: request.cursorOffset,
            diagnostics: request.diagnostics,
            maxChars: this.config.queryMaxChars,
        });
        if (!query.trim()) {
            LOG.info('Zeta retrieval skipped because query is empty');
            return [];
        }
        const topN = Math.max(1, this.config.rerank.finalTopN);
        const signals = extractZetaSignals({
            windowText,
            cursorOffset: request.cursorOffset,
            recentEdits: request.recentEdits,
            diagnostics: request.diagnostics,
        });
        return this.retrieval.retrieve({
            query,
            fileMode: request.fileMode,
            signals: {
                cursorSymbol: signals.cursorSymbol,
                renamedSymbols: signals.renamedSymbols,
                diagnosticSymbols: signals.diagnosticSymbols,
                importedSymbols: signals.importedSymbols,
            },
            fuzzySymbols: signals.fuzzySymbols,
            topN,
            signal,
        }, {
            rerank: this.config.rerank,
            graph: this.config.graph,
            fuzzy: this.config.fuzzy,
        });
    }

    /** Конвертирует URI в workspace-relative путь, чтобы zeta21 prompt не содержал абсолютные пути в `<filename>` блоках. */
    private filePathForUri(uri: string): string {
        const fsPath = uriToFsPath(uri);
        let root: string | undefined;
        for (let i = 0; i < this.embedding.workspaceRoots.length; i++) {
            const candidate = this.embedding.workspaceRoots[i];
            if (fsPath === candidate || fsPath.startsWith(candidate + path.sep)) {
                root = candidate;
                break;
            }
        }
        return root ? path.relative(root, fsPath) : fsPath;
    }

    /** Переписывает URI recent edit-ов на workspace-relative пути, чтобы edit_history следовал training-format модели. */
    private recentEditsForPrompt(recentEdits: ZetaRequest['recentEdits']): ZetaRequest['recentEdits'] {
        const out = new Array<ZetaRequest['recentEdits'][number]>(recentEdits.length);
        for (let i = 0; i < recentEdits.length; i++) {
            const edit = recentEdits[i];
            out[i] = { ...edit, uri: this.filePathForUri(edit.uri) };
        }
        return out;
    }

    /** Создаёт пустой ZetaResponse для skip/reject/error путей без лишнего telemetry wire-format. */
    private emptyResponse(): ZetaResponse {
        return {
            edits: [],
            primaryRange: null,
            jumpTo: null,
            modelId: ZETA_PROFILE.id,
        };
    }

    /** Создаёт успешный ZetaResponse только с данными которые нужны NES renderer и jump/accept UX. */
    private successResponse(edits: TextEditDTO[], primaryRange: ZetaResponse['primaryRange'], jumpTo: ZetaResponse['jumpTo']): ZetaResponse {
        return {
            edits,
            primaryRange,
            jumpTo,
            modelId: ZETA_PROFILE.id,
        };
    }
}

interface NormalizedZetaRequest {
    windowText: string;
    prefixText: string;
    suffixText: string;
    currentFilePath: string;
}

function defaultZetaConfig(): ZetaConfig {
    return {
        llamaUrl: 'http://127.0.0.1:8010',
        requestModelName: ZETA_PROFILE.model,
        contextSize: ZETA_PROFILE.contextTokens,
        debounceMs: 500,
        ragEnabled: true,
        relatedTopN: 5,
        queryMaxChars: 400,
        rerank: {
            enabled: false,
            llamaUrl: 'http://127.0.0.1:8030/v1',
            model: 'qwen3-reranker-0.6b',
            instruction: "Instruct: Given the current code edit and cursor context, judge whether the code snippet is useful for predicting the developer's next edit. Prefer snippets that define or call the symbols being edited.",
            candidatePoolN: 24,
            rerankTopN: 16,
            finalTopN: 8,
            ambiguityMargin: 0.002,
            timeoutMs: 1500,
            maxDocChars: 2000,
        },
        graph: { enabled: true },
        fuzzy: { enabled: true },
    };
}

function bridgeCancellation(token?: CancellationToken): { signal: AbortSignal; dispose(): void } {
    const controller = new AbortController();
    let disposable: Disposable | undefined;
    if (token?.isCancellationRequested) {
        controller.abort();
    } else if (token) {
        disposable = token.onCancellationRequested(() => controller.abort());
    }
    return {
        signal: controller.signal,
        dispose: () => disposable?.dispose(),
    };
}

function uriToFsPath(uri: string): string {
    try {
        return uri.startsWith('file:') ? fileURLToPath(uri) : uri;
    } catch {
        return uri;
    }
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

function shiftWindowStart(windowText: string, windowStart: ZetaRequest['windowStart'], offset: number): ZetaRequest['windowStart'] {
    if (offset <= 0) {
        return windowStart;
    }
    const limit = Math.min(offset, windowText.length);
    let line = windowStart.line;
    let character = windowStart.character;
    for (let i = 0; i < limit; i++) {
        if (windowText.charCodeAt(i) === 10) {
            line++;
            character = 0;
        } else {
            character++;
        }
    }
    return { line, character };
}
