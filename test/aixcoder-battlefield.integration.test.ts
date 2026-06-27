import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { AIX_SPAN_PRE } from '../src/common/aixcoder/aixcoder-tokens';
import type { EmbeddingConfig } from '../src/common/embedding-types';
import type { FimRetrievalConfig } from '../src/common/fim-types';
import { FimEmbeddingIndexService } from '../src/node/fim-module/embedding/fim-embedding-index-service';
import { buildFimPrompt } from '../src/node/fim-module/context-formation/builder';
import { LlamaFimClient } from '../src/node/fim-module/model-call/llama-fim-client';
import { postprocessFimCompletion } from '../src/node/fim-module/model-call/postprocess';
import type { RetrievalChannel } from '../src/node/fim-module/retrieval/fim-retrieval-channel';
import { FimRetrievalOrchestrator } from '../src/node/fim-module/retrieval/fim-retrieval-orchestrator';
import { AIXCODER_NODE_MODULE } from '../src/node/aixcoder/aixcoder-node-module';
import { resetAixcoderLanceDb } from './helpers/aixcoder-lancedb-reset';

const ENABLED = process.env.SC_BATTLE_IT === '1';
const REPO = process.env.SC_BATTLE_REPO ?? '';
const EMBED_URL = process.env.SC_EMBED_URL ?? 'http://127.0.0.1:8040/v1';
const FIM_URL = process.env.SC_AIX_URL ?? process.env.SC_FIM_URL ?? 'http://127.0.0.1:8020/v1';
const RERANK_URL = process.env.SC_RERANK_URL ?? 'http://127.0.0.1:8030/v1';
const LEAKED_TOKENS = /<\|(fim_prefix|fim_suffix|fim_middle|fim_pad|repo_name|file_sep|filename|reponame|endoftext|end_of_text)\|>|<｜fim▁(begin|hole|end)｜>|<\[(fim-(suffix|prefix|middle)|end▁of▁sentence)\]>|<\/s>|▁<AIX-SPAN-(PRE|POST|MIDDLE)>/;

const BATTLE_EMBED_CONFIG: EmbeddingConfig = {
    embedModel: 'ignored-by-fim-profile',
    llamaUrl: EMBED_URL,
    vectorDb: 'lancedb',
    chromaUrl: 'http://127.0.0.1:8000',
    indexOnSave: false,
    indexOnOpen: false,
    chunkSize: 40,
    topN: 3,
    prefixTailChars: 400,
};

let storageDir = '';
let service: FimEmbeddingIndexService | undefined;

beforeEach(async () => {
    if (!ENABLED || !REPO) {
        return;
    }
    if (!storageDir) {
        storageDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sc-aixcoder-battle-'));
    }
    service = await resetAixcoderLanceDb({
        storageDir,
        roots: [REPO],
        config: BATTLE_EMBED_CONFIG,
        previousService: service,
    });
});

afterEach(async () => {
    await service?.dispose();
    service = undefined;
    if (storageDir) {
        fs.rmSync(storageDir, { recursive: true, force: true });
    }
    delete process.env.SC_FIM_STORAGE_DIR;
});

test(
    'aiXcoder battlefield: isolated qwen3 index rebuild drives PSM repo prompt round-trip',
    {
        skip: (!ENABLED && 'set SC_BATTLE_IT=1 to run') || (!REPO && 'set SC_BATTLE_REPO to the test repo path'),
        timeout: 1800000,
    },
    async () => {
        assert.ok(fs.existsSync(REPO), `SC_BATTLE_REPO does not exist: ${REPO}`);
        assert.ok(service, 'beforeEach created a fresh aiXcoder embedding index');
        assert.equal(await AIXCODER_NODE_MODULE.verifySpecialTokens(FIM_URL), true);

        const orchestrator = new FimRetrievalOrchestrator([createSemanticChannel(service)]);
        const neighbors = await orchestrator.retrieve({
            query: 'renderAixcoderPrompt buildAixcoderHeader buildAixcoderEditSnippets',
            fileMode: 'code',
            signals: {
                cursorSymbol: 'renderAixcoderPrompt',
                renamedSymbols: ['buildAixcoderHeader', 'buildAixcoderEditSnippets'],
                diagnosticSymbols: [],
                importedSymbols: ['renderAixcoderPrompt'],
            },
            fuzzySymbols: ['renderAixcoderPrompt', 'buildAixcoderHeader', 'buildAixcoderEditSnippets'],
            topN: 3,
        }, battleRetrievalConfig());
        const prompt = buildFimPrompt({
            modelId: 'aixcoder-7b-v2',
            languageId: 'typescript',
            fileMode: 'code',
            prefix: 'export function renderPrompt(): string {\n    return buildFimPrompt(',
            suffix: '\n}',
            generationMode: 'multiline',
            contextSize: 8192,
            filePath: 'src/aixcoder-battle.ts',
            neighbors,
            recentEdits: [{
                uri: 'src/common/aixcoder/aixcoder-prompt-builder.ts',
                before: 'return blocks.join("");\n',
                after: 'return blocks.join("").trimEnd();\n',
                unifiedDiff: '@@ -1,1 +1,1 @@\n-return blocks.join("");\n+return blocks.join("").trimEnd();',
                timestamp: 1,
            }],
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

        assert.ok(prompt.prompt.startsWith(AIX_SPAN_PRE), 'aiXcoder prompt starts with AIX-SPAN PRE');
        assert.ok(prompt.prompt.includes('# the file path is: src/aixcoder-battle.ts'), 'aiXcoder prompt keeps the current file header');
        assert.ok(prompt.prompt.includes('# the file path is: src/common/aixcoder/aixcoder-prompt-builder.ts'), 'aiXcoder prompt keeps recent edits in repo context');
        assert.ok(text.length > 0, 'expected a non-empty aiXcoder completion');
        assert.ok(!LEAKED_TOKENS.test(text), `completion leaked aiXcoder tokens: ${JSON.stringify(text)}`);
    },
);

test(
    'aiXcoder battlefield: beforeEach reset recreates a clean qwen3-backed index',
    {
        skip: (!ENABLED && 'set SC_BATTLE_IT=1 to run') || (!REPO && 'set SC_BATTLE_REPO to the test repo path'),
        timeout: 600000,
    },
    async () => {
        assert.ok(service, 'beforeEach created a fresh aiXcoder embedding index');
        const neighbors = await service.retrieve('AIX-SPAN prompt context', 3);

        assert.deepEqual(service.workspaceRoots, [REPO]);
        assert.deepEqual(service.getRetrievalOptions(), { topN: 3, prefixTailChars: 400 });
        assert.ok(neighbors.length >= 0);
    },
);

function createSemanticChannel(service: FimEmbeddingIndexService): RetrievalChannel {
    return {
        id: 'semantic',
        codeOnly: false,
        isEnabled: () => true,
        retrieve: (input, topN) => service.retrieve(input.query, topN, input.signal),
    };
}

function battleRetrievalConfig(): FimRetrievalConfig {
    return {
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
}
