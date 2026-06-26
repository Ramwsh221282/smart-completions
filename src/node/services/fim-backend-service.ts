import * as path from 'path';
import { fileURLToPath } from 'url';
import { injectable, inject } from '@theia/core/shared/inversify';
import { CancellationToken, Disposable } from '@theia/core/lib/common';
import { FimBackendService } from '../../common/protocol';
import { FimConfig, FimRequest, FimResponse } from '../../common/fim-types';
import { buildFimPrompt } from '../fim-module/context-formation/builder';
import { getFimModelSpec } from '../fim-module/context-formation/model-spec';
import { LlamaFimClient } from '../fim-module/model-call/llama-fim-client';
import { postprocessFimCompletion } from '../fim-module/model-call/postprocess';
import { normalizeCrlf } from '../util/crlf';
import { EmbeddingIndexServiceImpl } from './embedding-index-service';

const DEFAULT_FIM_CONFIG: FimConfig = {
    modelId: 'qwen2.5-coder',
    llamaUrl: 'http://127.0.0.1:8020/v1',
    contextSize: 32768,
    debounceMs: 120,
    generationMode: 'multiline',
    temperature: 0.05,
    ragEnabled: true,
    contextSources: {
        recentEdits: false,
        repoContext: true,
        diagnostics: false,
    },
};

@injectable()
export class FimBackendServiceImpl implements FimBackendService {
    @inject(EmbeddingIndexServiceImpl) private readonly embedding!: EmbeddingIndexServiceImpl;

    private config = DEFAULT_FIM_CONFIG;
    private readonly client = new LlamaFimClient();

    async configure(config: FimConfig): Promise<void> {
        this.config = {
            ...config,
            contextSize: Math.max(1024, config.contextSize),
            temperature: Math.min(0.1, Math.max(0, config.temperature)),
        };
    }

    async complete(request: FimRequest, token?: CancellationToken): Promise<FimResponse> {
        if (token?.isCancellationRequested) {
            return { text: '', modelId: this.config.modelId };
        }
        const abort = bridgeCancellation(token);
        try {
            const spec = getFimModelSpec(this.config.modelId);
            const generationMode = request.generationMode ?? this.config.generationMode;
            const prefix = normalizeCrlf(request.prefix);
            const suffix = normalizeCrlf(request.suffix);
            const neighbors = spec.supportsRepoContext && this.config.ragEnabled && this.config.contextSources.repoContext
                ? await this.retrieveNeighbors(prefix, abort.signal)
                : [];
            const prompt = buildFimPrompt({
                modelId: this.config.modelId,
                fileMode: request.fileMode,
                prefix,
                suffix,
                generationMode,
                contextSize: this.config.contextSize,
                repoName: this.repoNameForUri(request.uri),
                filePath: this.filePathForUri(request.uri),
                neighbors,
            });
            const rawText = await this.client.complete({
                baseUrl: this.config.llamaUrl,
                model: prompt.llamaModel,
                prompt: prompt.prompt,
                stop: prompt.stop,
                maxTokens: prompt.maxTokens,
                temperature: this.config.temperature,
                signal: abort.signal,
            });
            return {
                text: postprocessFimCompletion(rawText, { suffix, generationMode, stopTokens: prompt.stop }),
                modelId: this.config.modelId,
            };
        } catch (error) {
            if (abort.signal.aborted || isAbortError(error)) {
                return { text: '', modelId: this.config.modelId };
            }
            throw error;
        } finally {
            abort.dispose();
        }
    }

    private async retrieveNeighbors(prefix: string, signal?: AbortSignal) {
        const options = this.embedding.getRetrievalOptions();
        const query = prefix.slice(-options.prefixTailChars);
        if (!query.trim()) {
            return [];
        }
        return this.embedding.retrieve(query, options.topN, signal);
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
        return this.embedding.workspaceRoots.find(root => fsPath === root || fsPath.startsWith(root + path.sep));
    }
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
