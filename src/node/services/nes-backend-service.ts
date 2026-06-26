import * as path from 'path';
import { fileURLToPath } from 'url';
import { injectable, inject } from '@theia/core/shared/inversify';
import { CancellationToken, Disposable } from '@theia/core/lib/common';
import { NesBackendService } from '../../common/protocol';
import { NesConfig, NesRequest, NesResponse, NesResponseStatus } from '../../common/nes-types';
import { RecentEdit } from '../../common/edit-history-types';
import type { TextEditDTO } from '../../common/editor-dto';
import { buildNesPrompt } from '../nes-module/context-formation/builder';
import type { BuiltNesPrompt } from '../nes-module/context-formation/builder';
import { buildNesRetrievalQuery } from '../../common/nes-context/retrieval-queries';
import { LlamaNesClient } from '../nes-module/model-call/llama-nes-client';
import { parseNesCompletion } from '../nes-module/model-call/response-parser';
import { normalizeCrlf } from '../util/crlf';
import { countLines } from '../../common/text/line-index';
import { getSweepProfile, sweepRequestModelName } from '../../common/sweep/profiles';
import { SweepConfig, SweepRequest } from '../../common/sweep/types';
import { SweepBackendService } from '../sweep/sweep-backend-service';
import { EmbeddingIndexServiceImpl } from './embedding-index-service';
import { charTokenEstimate } from '../sweep/token-budget/token-counter';

const DEFAULT_SWEEP_PROFILE = getSweepProfile('v2-7b');

const DEFAULT_NES_CONFIG: NesConfig = {
    modelId: 'sweep-default',
    llamaUrl: 'http://127.0.0.1:8030/v1',
    contextSize: 16384,
    debounceMs: 500,
    editVolume: 'medium',
    ragEnabled: true,
    relatedTopN: 5,
    queryMaxChars: 400,
    profile: DEFAULT_SWEEP_PROFILE,
    requestModelName: sweepRequestModelName(DEFAULT_SWEEP_PROFILE.id, ''),
};

@injectable()
export class NesBackendServiceImpl implements NesBackendService {
    @inject(EmbeddingIndexServiceImpl) private readonly embedding!: EmbeddingIndexServiceImpl;
    @inject(SweepBackendService) private readonly sweep!: SweepBackendService;

    private config = DEFAULT_NES_CONFIG;
    private readonly client = new LlamaNesClient();

    async configure(config: NesConfig): Promise<void> {
        this.config = {
            ...config,
            contextSize: Math.max(1024, config.contextSize),
        };
        if (isSweepModelId(this.config.modelId)) {
            await this.sweep.configure(this.config as SweepConfig);
        }
    }

    async predict(request: NesRequest, token?: CancellationToken): Promise<NesResponse> {
        const startedAt = Date.now();
        if (isSweepModelId(this.config.modelId)) {
            return this.sweep.predict(request as SweepRequest, token);
        }
        if (request.recentEdits.length === 0 || token?.isCancellationRequested) {
            return this.emptyResponse(request, 'no-edit', request.recentEdits.length === 0 ? 'no-recent-edits' : 'cancelled', startedAt);
        }
        const abort = bridgeCancellation(token);
        try {
            const windowText = normalizeCrlf(request.windowText);
            const neighbors = this.config.ragEnabled ? await this.retrieveNeighbors(request, windowText, abort.signal) : [];
            const prompt = buildNesPrompt({
                modelId: this.config.modelId,
                filePath: this.filePathForUri(request.uri),
                windowText,
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
            });
            if (prompt.overflow) {
                return this.emptyResponse(request, 'overflow', 'prompt-overflow', startedAt, prompt);
            }
            const rawText = await this.client.complete({
                baseUrl: this.config.llamaUrl,
                model: prompt.model,
                prompt: prompt.prompt,
                stop: prompt.stop,
                maxTokens: prompt.maxTokens,
                temperature: 0.05,
                signal: abort.signal,
            });
            const parsed = parseNesCompletion({ rawText, oldWindowText: windowText, windowStart: request.windowStart, stopTokens: prompt.stop });
            if (parsed.edits.length === 0) {
                return this.emptyResponse(request, 'no-edit', 'no-visible-edit', startedAt, prompt);
            }
            return this.successResponse(request, parsed.edits, parsed.primaryRange, parsed.jumpTo, startedAt, prompt);
        } catch (error) {
            if (abort.signal.aborted || isAbortError(error)) {
                return this.emptyResponse(request, 'no-edit', 'cancelled', startedAt);
            }
            return this.emptyResponse(request, 'error', error instanceof Error ? error.message : String(error), startedAt);
        } finally {
            abort.dispose();
        }
    }

    // Retrieval-запрос NES строится из edit-сигнала (символ под курсором, переименованные
    // символы, символы диагностик, импорты/типы/тесты) + хвост unified diff правок, а не из
    // слепого окна: так точнее находятся кросс-файловые зависимости.
    private async retrieveNeighbors(request: NesRequest, windowText: string, signal?: AbortSignal) {
        const options = this.embedding.getRetrievalOptions();
        const query = buildNesRetrievalQuery({
            recentEdits: request.recentEdits,
            windowText,
            cursorOffset: request.cursorOffset,
            diagnostics: request.diagnostics,
            maxChars: options.prefixTailChars,
        });
        if (!query.trim()) {
            return [];
        }
        return this.embedding.retrieve(query, options.topN, signal);
    }

    private filePathForUri(uri: string): string {
        const fsPath = uriToFsPath(uri);
        const root = this.embedding.workspaceRoots.find(candidate => fsPath === candidate || fsPath.startsWith(candidate + path.sep));
        return root ? path.relative(root, fsPath) : fsPath;
    }

    // Метки {path}.diff блоков должны быть workspace-relative путями (модель обучена на путях).
    private recentEditsForPrompt(recentEdits: RecentEdit[]): RecentEdit[] {
        return recentEdits.map(edit => ({ ...edit, uri: this.filePathForUri(edit.uri) }));
    }

    /** Создаёт пустой legacy NES-ответ с meta, чтобы telemetry не зависела от Sweep-only path. */
    private emptyResponse(request: NesRequest, status: NesResponseStatus, rejectReason: string | undefined, startedAt: number, prompt?: BuiltNesPrompt): NesResponse {
        return {
            edits: [],
            modelId: this.config.modelId,
            requestId: request.requestId,
            meta: {
                status,
                rejectReason,
                durationMs: Date.now() - startedAt,
                promptTokens: prompt ? charTokenEstimate(prompt.prompt) : undefined,
                tokenMode: 'char-fallback',
                contextProfile: this.config.modelId,
                editLineCount: undefined,
            },
        };
    }

    /** Создаёт успешный legacy NES-ответ и приводит его к общему telemetry wire-format. */
    private successResponse(request: NesRequest, edits: TextEditDTO[], primaryRange: NesResponse['primaryRange'], jumpTo: NesResponse['jumpTo'], startedAt: number, prompt: BuiltNesPrompt): NesResponse {
        return {
            edits,
            primaryRange,
            jumpTo,
            modelId: this.config.modelId,
            requestId: request.requestId,
            meta: {
                status: 'edit',
                rejectReason: undefined,
                durationMs: Date.now() - startedAt,
                promptTokens: charTokenEstimate(prompt.prompt),
                tokenMode: 'char-fallback',
                contextProfile: this.config.modelId,
                editLineCount: editLineCount(edits),
            },
        };
    }
}

/** Считает размер legacy NES-правки для единого frontend telemetry snapshot. */
function editLineCount(edits: TextEditDTO[]): number {
    let total = 0;
    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        const removed = Math.max(0, edit.range.end.line - edit.range.start.line);
        const inserted = edit.newText ? countLines(edit.newText) : 0;
        total += Math.max(removed, inserted);
    }
    return total;
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

function isSweepModelId(modelId: string): modelId is 'sweep-default' | 'sweep-small' {
    return modelId === 'sweep-default' || modelId === 'sweep-small';
}
