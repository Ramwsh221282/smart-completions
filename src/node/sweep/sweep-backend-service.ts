import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inject, injectable } from '@theia/core/shared/inversify';
import { CancellationToken, Disposable } from '@theia/core/lib/common';
import type { Neighbor } from '../../common/embedding-types';
import type { TextEditDTO } from '../../common/editor-dto';
import { RecentEdit } from '../../common/edit-history-types';
import { SweepLogger } from '../../common/sweep/logger';
import { getSweepProfile, sweepRequestModelName } from '../../common/sweep/profiles';
import { buildSweepRetrievalQuery } from '../../common/sweep/retrieval-queries';
import { diagnosticSymbols, importedSymbols, renamedSymbols, symbolAtCursor } from '../../common/sweep/signals';
import { DEFAULT_SWEEP_FUZZY_CONFIG, DEFAULT_SWEEP_GRAPH_CONFIG, DEFAULT_SWEEP_RERANK_CONFIG, GraphQuerySignals, SweepConfig, SweepRequest, SweepResponse, SweepRerankConfig } from '../../common/sweep/types';
import { normalizeCrlf } from '../../common/text/crlf';
import { EmbeddingIndexServiceImpl } from '../services/embedding-index-service';
import { LlamaSweepClient } from './model-call-layer/llama-sweep-client';
import { parseSweepCompletion } from './model-call-layer/sweep-response-parser';
import { SweepSyntaxGate } from './model-call-layer/syntax-gate';
import { buildSweepPrompt } from './prompt-creating-layer/sweep-prompt-builder';
import { SweepRetrievalOrchestrator } from './retrieval/sweep-retrieval-orchestrator';
import { QwenTokenCounter } from './token-budget/token-counter';

// Логгер бекенд-оркестратора; нужен для сквозной диагностики полного цикла предсказания от retrieval до парсинга.
const LOG = new SweepLogger('node:backend-service');
const DEFAULT_SWEEP_PROFILE = getSweepProfile('v2-7b');

/** Оркестрирует полный цикл Sweep-предсказания: RAG-retrieval → промпт → llama.cpp → парсинг → NES-ответ. */
@injectable()
export class SweepBackendService {
    // Embedding-сервис; нужен для RAG-retrieval и получения workspace roots для нормализации путей.
    @inject(EmbeddingIndexServiceImpl) private readonly embedding!: EmbeddingIndexServiceImpl;
    @inject(SweepRetrievalOrchestrator) private readonly retrieval!: SweepRetrievalOrchestrator;

    // Конфиг с дефолтами; перезаписывается через configure() при изменении preferences на фронтенде.
    private config: SweepConfig = {
        modelId: 'sweep-default',
        llamaUrl: 'http://127.0.0.1:8010/v1',
        contextSize: 16384,
        debounceMs: 500,
        editVolume: 'medium',
        ragEnabled: true,
        relatedTopN: 5,
        queryMaxChars: 400,
        profile: DEFAULT_SWEEP_PROFILE,
        requestModelName: sweepRequestModelName(DEFAULT_SWEEP_PROFILE.id, ''),
        rerank: DEFAULT_SWEEP_RERANK_CONFIG,
        graph: DEFAULT_SWEEP_GRAPH_CONFIG,
        fuzzy: DEFAULT_SWEEP_FUZZY_CONFIG,
    };

    // Клиент llama.cpp; создаётся один раз потому что не хранит состояния между вызовами.
    private readonly client = new LlamaSweepClient();
    // Tokenizer lazy-load нужен только в момент сборки prompt, поэтому держим один кэшированный экземпляр.
    private readonly tokenCounter = new QwenTokenCounter();
    // Syntax gate держит parser и WASM-грамматики в памяти между запросами, чтобы проверка была дешёвой.
    private readonly syntaxGate = new SweepSyntaxGate();

    /**
     * Принимает новый конфиг от фронтенда через NES-фасад; contextSize клампируется снизу
     * чтобы слишком маленькое значение не привело к overflow при каждом запросе.
     */
    async configure(config: SweepConfig): Promise<void> {
        this.config = {
            ...config,
            contextSize: Math.max(1024, config.contextSize),
            rerank: sanitizeRerankConfig(config.rerank),
            graph: config.graph ?? DEFAULT_SWEEP_GRAPH_CONFIG,
            fuzzy: config.fuzzy ?? DEFAULT_SWEEP_FUZZY_CONFIG,
        };
        LOG.info('Sweep backend configured', { ...this.config, contextProfile: this.config.profile.id });
        await this.tokenCounter.ensureReady();
        await this.retrieval.configure(this.config.rerank);
    }

    /**
     * Выполняет одно Sweep-предсказание: retrieval → buildSweepPrompt → complete → parseSweepCompletion;
     * возвращает пустой ответ если история правок пуста, запрос отменён или промпт переполнен.
     */
    async predict(request: SweepRequest, token?: CancellationToken): Promise<SweepResponse> {
        const startedAt = Date.now();
        if (request.recentEdits.length === 0 || token?.isCancellationRequested) {
            LOG.info('Sweep prediction skipped', { reason: request.recentEdits.length === 0 ? 'no recent edits' : 'cancelled' });
            return this.emptyResponse();
        }
        const abort = bridgeCancellation(token);
        try {
            const windowText = normalizeCrlf(request.windowText);
            const neighbors = this.config.ragEnabled ? await this.retrieveNeighbors(request, windowText, abort.signal) : [];
            await this.tokenCounter.ensureReady();
            const prompt = buildSweepPrompt({
                modelId: this.config.modelId,
                filePath: this.filePathForUri(request.uri),
                fileMode: request.fileMode,
                windowText,
                broadFileText: normalizeCrlf(request.broadFileText ?? request.windowText),
                broadFileStartLine: request.broadFileStartLine,
                windowStartLine: request.windowStart.line,
                originalWindowText: request.originalWindowText,
                cursorOffset: request.cursorOffset,
                recentEdits: this.recentEditsForPrompt(request.recentEdits),
                diagnostics: request.diagnostics,
                neighbors,
                relatedFiles: request.relatedFiles,
                outline: request.outline,
                outputSnippets: request.outputSnippets,
                editVolume: this.config.editVolume,
                injectInlineDiagnostics: this.config.injectInlineDiagnostics,
                contextSize: this.config.contextSize,
                profile: this.config.profile,
                requestModelName: this.config.requestModelName,
                tokenCounter: this.tokenCounter,
            });
            if (prompt.overflow) {
                LOG.warn('Sweep prediction skipped because prompt overflowed', { requestId: request.requestId });
                return this.emptyResponse();
            }
            const rawText = await this.client.complete({
                baseUrl: this.config.llamaUrl,
                model: prompt.model,
                prompt: prompt.prompt,
                stop: prompt.stop,
                maxTokens: prompt.maxTokens,
                temperature: this.config.profile.temperature,
                cachePrompt: true,
                seed: 0,
                signal: abort.signal,
            });
            const parsed = parseSweepCompletion({
                rawText,
                oldWindowText: windowText,
                windowStart: request.windowStart,
                stopTokens: prompt.stop,
                prefill: prompt.prefill,
                cursorOffset: request.cursorOffset,
            });
            if (parsed.edits.length === 0) {
                LOG.info('Sweep prediction completed without visible edit', { requestId: request.requestId, durationMs: Date.now() - startedAt, status: parsed.status, rejectReason: parsed.rejectReason });
                return this.emptyResponse();
            }
            if (request.fileMode === 'code' && parsed.updatedWindow) {
                const delta = await this.syntaxGate.errorDelta(windowText, parsed.updatedWindow, request.languageId);
                if (delta !== undefined && delta > 0) {
                    LOG.info('Sweep edit rejected by syntax gate', { requestId: request.requestId, delta });
                    return this.emptyResponse();
                }
            }
            LOG.info('Sweep prediction completed', { requestId: request.requestId, durationMs: Date.now() - startedAt, edits: parsed.edits.length });
            return this.successResponse(parsed.edits, parsed.primaryRange, parsed.jumpTo);
        } catch (error) {
            if (abort.signal.aborted || isAbortError(error)) {
                LOG.info('Sweep prediction cancelled', { requestId: request.requestId });
                return this.emptyResponse();
            }
            LOG.error('Sweep prediction failed', { requestId: request.requestId, error: error instanceof Error ? error.message : String(error) });
            return this.emptyResponse();
        } finally {
            abort.dispose();
        }
    }

    /**
     * Выполняет RAG-retrieval с Sweep edit-signal запросом; skip если запрос пустой
     * чтобы не тратить время на embedding-вызов без полезного сигнала.
     */
    private async retrieveNeighbors(request: SweepRequest, windowText: string, signal?: AbortSignal): Promise<Neighbor[]> {
        const options = this.embedding.getRetrievalOptions();
        const query = buildSweepRetrievalQuery({
            recentEdits: request.recentEdits,
            windowText,
            cursorOffset: request.cursorOffset,
            diagnostics: request.diagnostics,
            maxChars: this.config.queryMaxChars || options.prefixTailChars,
        });
        if (!query.trim()) {
            LOG.info('Sweep retrieval skipped because query is empty');
            return [];
        }
        if (options.topN <= 0) {
            return [];
        }
        const signals: GraphQuerySignals = {
            cursorSymbol: symbolAtCursor(windowText, request.cursorOffset),
            renamedSymbols: renamedSymbols(request.recentEdits),
            diagnosticSymbols: diagnosticSymbols(request.diagnostics),
            importedSymbols: importedSymbols(windowText),
        };
        const fuzzySymbols = [signals.cursorSymbol, ...signals.renamedSymbols, ...signals.diagnosticSymbols];
        return this.retrieval.retrieve({ query, fileMode: request.fileMode, signals, fuzzySymbols, topN: options.topN, signal }, {
            rerank: this.config.rerank,
            graph: this.config.graph,
            fuzzy: this.config.fuzzy,
        });
    }

    /**
     * Конвертирует URI файла в workspace-relative путь для заголовков Sweep file-блоков;
     * нужен чтобы пути в промпте совпадали с training-форматом а не содержали абсолютные пути.
     */
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

    /**
     * Перезаписывает URI в RecentEdit-объектах на workspace-relative пути
     * чтобы заголовки `{path}.diff` блоков в промпте были короткими и читаемыми.
     */
    private recentEditsForPrompt(recentEdits: RecentEdit[]): RecentEdit[] {
        const out = new Array<RecentEdit>(recentEdits.length);
        for (let i = 0; i < recentEdits.length; i++) {
            const edit = recentEdits[i];
            out[i] = { ...edit, uri: this.filePathForUri(edit.uri) };
        }
        return out;
    }

    /** Создаёт пустой SweepResponse без telemetry wire-format для skip/reject/error путей. */
    private emptyResponse(): SweepResponse {
        return {
            edits: [],
            modelId: this.config.modelId,
        };
    }

    /** Создаёт успешный SweepResponse только с данными, которые нужны View Zone renderer. */
    private successResponse(edits: TextEditDTO[], primaryRange: SweepResponse['primaryRange'], jumpTo: SweepResponse['jumpTo']): SweepResponse {
        return {
            edits,
            primaryRange,
            jumpTo,
            modelId: this.config.modelId,
        };
    }
}

/**
 * Преобразует Theia CancellationToken в AbortController/AbortSignal чтобы fetch и embedding
 * могли прерываться через стандартный Web API при отмене Sweep-запроса.
 */
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

/**
 * Конвертирует file:// URI в filesystem путь терпимо к уже нормализованным путям;
 * нужен потому что фронтенд передаёт Monaco URI а path.relative ожидает fs-путь.
 */
function uriToFsPath(uri: string): string {
    try {
        return uri.startsWith('file:') ? fileURLToPath(uri) : uri;
    } catch {
        return uri;
    }
}

/**
 * Проверяет что ошибка является AbortError чтобы отменённые Sweep-вызовы
 * не всплывали пользователю как видимые сбои предсказания.
 */
function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

/** Клампит rerank preferences к безопасным значениям перед использованием в hot path. */
function sanitizeRerankConfig(config: SweepRerankConfig | undefined): SweepRerankConfig {
    const source = config ?? DEFAULT_SWEEP_RERANK_CONFIG;
    return {
        enabled: source.enabled,
        llamaUrl: source.llamaUrl || DEFAULT_SWEEP_RERANK_CONFIG.llamaUrl,
        model: source.model || DEFAULT_SWEEP_RERANK_CONFIG.model,
        instruction: source.instruction || DEFAULT_SWEEP_RERANK_CONFIG.instruction,
        candidatePoolN: Math.max(1, Math.floor(source.candidatePoolN)),
        rerankTopN: Math.max(1, Math.floor(source.rerankTopN)),
        finalTopN: Math.max(1, Math.floor(source.finalTopN)),
        ambiguityMargin: Math.max(0, source.ambiguityMargin),
        timeoutMs: Math.max(1, Math.floor(source.timeoutMs)),
        maxDocChars: Math.max(1, Math.floor(source.maxDocChars)),
    };
}
