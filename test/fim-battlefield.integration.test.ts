import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FimRetrievalConfig } from '../src/common/fim-types';
import { buildFimPrompt } from '../src/node/fim-module/context-formation/builder';
import type { RetrievalChannel } from '../src/node/fim-module/retrieval/fim-retrieval-channel';
import { FimRetrievalOrchestrator } from '../src/node/fim-module/retrieval/fim-retrieval-orchestrator';
import { FimEmbeddingIndexService } from '../src/node/fim-module/embedding/fim-embedding-index-service';
import { LlamaFimClient } from '../src/node/fim-module/model-call/llama-fim-client';
import { postprocessFimCompletion } from '../src/node/fim-module/model-call/postprocess';
import { resetFimLanceDb } from './helpers/fim-lancedb-reset';

const ENABLED = process.env.SC_BATTLE_IT === '1';
const REPO = process.env.SC_BATTLE_REPO ?? '';
const EMBED_URL = process.env.SC_EMBED_URL ?? 'http://127.0.0.1:8040/v1';
const FIM_URL = process.env.SC_FIM_URL ?? 'http://127.0.0.1:8020/v1';
const RERANK_URL = process.env.SC_RERANK_URL ?? 'http://127.0.0.1:8030/v1';
const FIM_TOKENS = /<\|(fim_prefix|fim_suffix|fim_middle|fim_pad|repo_name|file_sep|filename|reponame|endoftext|end_of_text)\|>|<｜fim▁(begin|hole|end)｜>|<\[(fim-(suffix|prefix|middle)|end▁of▁sentence)\]>|<\/s>|▁<AIX-SPAN-(PRE|POST|MIDDLE)>/;

test('FIM battlefield: isolated index rebuilds and drives repo prompt round-trip', { skip: !ENABLED && 'set SC_BATTLE_IT=1 to run', timeout: 1800000 }, async () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fim-lancedb-'));
    const config = {
        embedModel: 'ignored-by-fim-profile',
        llamaUrl: EMBED_URL,
        vectorDb: 'lancedb' as const,
        chromaUrl: 'http://127.0.0.1:8000',
        indexOnSave: false,
        indexOnOpen: false,
        chunkSize: 40,
        topN: 3,
        prefixTailChars: 400,
    };
    let index: FimEmbeddingIndexService | undefined;
    try {
        index = await resetFimLanceDb({ storageDir, roots: [REPO], config, embedderId: 'jina-code' });
        const semanticChannel: RetrievalChannel = {
            id: 'semantic',
            codeOnly: false,
            isEnabled: () => true,
            retrieve: (input, topN) => {
                if (!index) {
                    throw new Error('FIM index is not ready');
                }
                return index.retrieve(input.query, topN, input.signal);
            },
        };
        const retrievalConfig: FimRetrievalConfig = {
            rerank: {
                enabled: Boolean(process.env.SC_RERANK_URL),
                llamaUrl: RERANK_URL,
                model: 'Qwen3-Reranker-0.6B',
                instruction: 'Instruct: Given the current incomplete code prefix and recent edits, judge whether the repository snippet is useful for predicting the missing code at the cursor.',
                candidatePoolN: 6,
                rerankTopN: 6,
                finalTopN: 3,
                ambiguityMargin: 0.002,
                timeoutMs: 3000,
                maxDocChars: 2000,
            },
            graph: { enabled: false },
            fuzzy: { enabled: false },
        };
        const orchestrator = new FimRetrievalOrchestrator([semanticChannel]);
        const prefix = 'export function renderPrompt(): string {\n    return buildFimPrompt(';
        const recentEdits = [{
            uri: 'src/node/fim-module/context-formation/builder.ts',
            before: 'return fim;\n',
            after: 'return buildFimPrompt(input);\n',
            unifiedDiff: '@@ -1,1 +1,1 @@\n-return fim;\n+return buildFimPrompt(input);',
            timestamp: 1,
        }];
        const neighbors = await orchestrator.retrieve({
            query: 'buildFimPrompt trimFimContext buildEditHistorySnippets',
            fileMode: 'code',
            signals: {
                cursorSymbol: 'buildFimPrompt',
                renamedSymbols: ['trimFimContext', 'buildEditHistorySnippets'],
                diagnosticSymbols: [],
                importedSymbols: ['buildFimPrompt'],
            },
            fuzzySymbols: ['buildFimPrompt', 'trimFimContext', 'buildEditHistorySnippets'],
            topN: 3,
        }, retrievalConfig);
        const prompt = buildFimPrompt({
            modelId: 'qwen2.5-coder',
            fileMode: 'code',
            prefix,
            suffix: '\n}',
            generationMode: 'multiline',
            contextSize: 8192,
            repoName: path.basename(REPO),
            filePath: 'src/fim-battle.ts',
            neighbors,
            recentEdits,
        });
        const client = new LlamaFimClient();
        const raw = await client.complete({
            baseUrl: FIM_URL,
            model: prompt.llamaModel,
            prompt: prompt.prompt,
            stop: prompt.stop,
            maxTokens: prompt.maxTokens,
            temperature: 0,
        });
        const text = postprocessFimCompletion(raw, { suffix: '\n}', generationMode: 'multiline', stopTokens: prompt.stop });

        assert.ok(prompt.prompt.includes('<|repo_name|>'), 'expected repo-level FIM prompt');
        assert.ok(prompt.prompt.includes('<|file_sep|>src/node/fim-module/context-formation/builder.ts'), 'expected recent-edit block in repo prompt');
        assert.ok(text.length > 0, 'expected a non-empty completion');
        assert.ok(!FIM_TOKENS.test(text), `completion leaked FIM tokens: ${JSON.stringify(text)}`);
    } finally {
        await index?.dispose();
        fs.rmSync(storageDir, { recursive: true, force: true });
        delete process.env.SC_FIM_STORAGE_DIR;
    }
});
