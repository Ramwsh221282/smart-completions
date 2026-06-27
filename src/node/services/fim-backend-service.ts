import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectable, inject } from '@theia/core/shared/inversify';
import { CancellationToken, Disposable } from '@theia/core/lib/common';
import { getFimNodeModule } from '../fim-module/fim-node-registry';
import { buildFimRetrievalQuery, extractFimSignals } from '../../common/fim/fim-retrieval-queries';
import { FimBackendService } from '../../common/protocol';
import { FimConfig, FimRequest, FimResponse } from '../../common/fim-types';
import { dedupeContextFiles } from '../../common/sweep/dedup-context';
import { buildFimPrompt } from '../fim-module/context-formation/builder';
import { FimEmbeddingIndexService } from '../fim-module/embedding/fim-embedding-index-service';
import { getFimModelSpec } from '../fim-module/context-formation/model-spec';
import { LlamaFimClient } from '../fim-module/model-call/llama-fim-client';
import { postprocessFimCompletion } from '../fim-module/model-call/postprocess';
import { FimRetrievalOrchestrator } from '../fim-module/retrieval/fim-retrieval-orchestrator';
import { normalizeCrlf } from '../util/crlf';

const DEFAULT_FIM_CONFIG: FimConfig = {
    modelId: 'seed-coder-8b',
    llamaUrl: 'http://127.0.0.1:8020/v1',
    contextSize: 32768,
    debounceMs: 120,
    generationMode: 'multiline',
    temperature: 0.05,
    ragEnabled: true,
    fimEmbedderId: 'qwen3-0.6b',
    embedding: {
        embedModel: 'Qwen3-Embedding-0.6B',
        llamaUrl: 'http://127.0.0.1:8040/v1',
        vectorDb: 'lancedb',
        chromaUrl: 'http://127.0.0.1:8000',
        indexOnSave: true,
        indexOnOpen: true,
        chunkSize: 40,
        topN: 4,
        prefixTailChars: 400,
    },
    retrieval: {
        rerank: {
            enabled: true,
            llamaUrl: 'http://127.0.0.1:8030/v1',
            model: 'Qwen3-Reranker-0.6B',
            instruction: 'Instruct: Given the current incomplete code prefix and recent edits, judge whether the repository snippet is useful for predicting the missing code at the cursor.',
            candidatePoolN: 16,
            rerankTopN: 16,
            finalTopN: 5,
            ambiguityMargin: 0.002,
            timeoutMs: 1500,
            maxDocChars: 2000,
        },
        graph: { enabled: true },
        fuzzy: { enabled: true },
    },
    contextSources: {
        recentEdits: true,
        repoContext: true,
        diagnostics: false,
    },
};

@injectable()
export class FimBackendServiceImpl implements FimBackendService {
    @inject(FimEmbeddingIndexService) private readonly fimIndex!: FimEmbeddingIndexService;
    @inject(FimRetrievalOrchestrator) private readonly retrieval!: FimRetrievalOrchestrator;

    private config = DEFAULT_FIM_CONFIG;
    private workspaceRoots: string[] = [];
    private readonly client = new LlamaFimClient();

    async configure(config: FimConfig, workspaceRoots?: string[]): Promise<void> {
        this.config = {
            ...config,
            contextSize: Math.max(1024, config.contextSize),
            temperature: Math.min(0.1, Math.max(0, config.temperature)),
        };
        await this.ensureSpecialTokens();
        if (workspaceRoots) {
            this.workspaceRoots = workspaceRoots.map(uriToFsPath);
        }
        await this.retrieval.configure(this.config.retrieval.rerank);
        if (this.workspaceRoots.length > 0) {
            await this.fimIndex.configure(this.config.embedding, this.workspaceRoots, this.config.fimEmbedderId);
        }
    }

    async reindexFile(uri: string): Promise<void> {
        await this.fimIndex.reindexFile(uri);
    }

    async rebuildIndex(): Promise<void> {
        await this.fimIndex.rebuild();
    }

    async complete(request: FimRequest, token?: CancellationToken): Promise<FimResponse> {
        if (token?.isCancellationRequested) {
            return this.emptyResponse();
        }
        const abort = bridgeCancellation(token);
        try {
            const normalized = this.normalizeRequest(request);
            const deduped = await this.loadRepoContext(request, normalized, abort.signal);
            const prompt = this.buildPrompt(request, normalized, deduped);
            return await this.completePrompt(prompt, normalized.suffix, normalized.generationMode, abort.signal);
        } catch (error) {
            if (abort.signal.aborted || isAbortError(error)) {
                return this.emptyResponse();
            }
            throw error;
        } finally {
            abort.dispose();
        }
    }

    private normalizeRequest(request: FimRequest): NormalizedFimRequest {
        return {
            generationMode: request.generationMode ?? this.config.generationMode,
            prefix: normalizeCrlf(request.prefix),
            suffix: normalizeCrlf(request.suffix),
            filePath: this.filePathForUri(request.uri),
        };
    }

    private async loadRepoContext(request: FimRequest, normalized: NormalizedFimRequest, signal?: AbortSignal) {
        const neighbors = await this.retrievePromptNeighbors(request, normalized.prefix, signal);
        return dedupeContextFiles({
            currentFilePath: normalized.filePath,
            neighbors,
            relatedFiles: request.relatedFiles ?? [],
        });
    }

    private async retrievePromptNeighbors(request: FimRequest, prefix: string, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof this.retrieveNeighbors>>> {
        const spec = getFimModelSpec(this.config.modelId);
        if (!spec.supportsRepoContext || !this.config.ragEnabled || !this.config.contextSources.repoContext) {
            return [];
        }
        return this.retrieveNeighbors(prefix, request, signal);
    }

    private buildPrompt(request: FimRequest, normalized: NormalizedFimRequest, deduped: ReturnType<typeof dedupeContextFiles>) {
        return buildFimPrompt({
            modelId: this.config.modelId,
            languageId: request.languageId,
            fileMode: request.fileMode,
            prefix: normalized.prefix,
            suffix: normalized.suffix,
            generationMode: normalized.generationMode,
            contextSize: this.config.contextSize,
            repoName: this.repoNameForUri(request.uri),
            filePath: normalized.filePath,
            neighbors: deduped.neighbors,
            relatedFiles: deduped.relatedFiles,
            recentEdits: this.config.contextSources.recentEdits ? request.recentEdits ?? [] : [],
        });
    }

    private async completePrompt(
        prompt: ReturnType<typeof buildFimPrompt>,
        suffix: string,
        generationMode: FimRequest['generationMode'],
        signal?: AbortSignal,
    ): Promise<FimResponse> {
        const rawText = await this.client.complete({
            baseUrl: this.config.llamaUrl,
            model: prompt.llamaModel,
            prompt: prompt.prompt,
            stop: prompt.stop,
            maxTokens: prompt.maxTokens,
            temperature: this.config.temperature,
            signal,
        });
        return {
            text: postprocessFimCompletion(rawText, { suffix, generationMode, stopTokens: prompt.stop }),
            modelId: this.config.modelId,
        };
    }

    private async retrieveNeighbors(prefix: string, request: FimRequest, signal?: AbortSignal) {
        const options = this.fimIndex.getRetrievalOptions();
        const recentEdits = request.recentEdits ?? [];
        const query = buildFimRetrievalQuery({
            prefix,
            recentEdits,
            prefixTailChars: options.prefixTailChars,
        });
        if (!query.trim()) {
            return [];
        }
        const signals = extractFimSignals(prefix.slice(-options.prefixTailChars), recentEdits);
        return this.retrieval.retrieve({
            query,
            fileMode: request.fileMode,
            signals: signals.graph,
            fuzzySymbols: signals.fuzzySymbols,
            topN: options.topN,
            signal,
        }, this.config.retrieval);
    }

    private repoNameForUri(uri: string): string {
        const root = this.workspaceRootForUri(uri);
        return root ? path.basename(root) : 'workspace';
    }

    private filePathForUri(uri: string): string {
        const fsPath = uriToFsPath(uri);
        const root = this.workspaceRootForUri(uri);
        return root ? path.relative(root, fsPath) : fsPath;
    }

    private workspaceRootForUri(uri: string): string | undefined {
        const fsPath = uriToFsPath(uri);
        return this.fimIndex.workspaceRoots.find(root => fsPath === root || fsPath.startsWith(root + path.sep));
    }

    private async ensureSpecialTokens(): Promise<void> {
        const nodeModule = getFimNodeModule(this.config.modelId);
        const ok = await nodeModule.verifySpecialTokens(this.config.llamaUrl);
        if (!ok) {
            throw new Error(`${nodeModule.modelId}: GGUF does not preserve special tokens`);
        }
    }

    private emptyResponse(): FimResponse {
        return { text: '', modelId: this.config.modelId };
    }
}

interface NormalizedFimRequest {
    generationMode: FimRequest['generationMode'];
    prefix: string;
    suffix: string;
    filePath: string;
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
