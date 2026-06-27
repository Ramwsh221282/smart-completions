import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Neighbor } from '../src/common/embedding-types';
import { buildFimPrompt } from '../src/node/fim-module/context-formation/builder';
import { LlamaFimClient } from '../src/node/fim-module/model-call/llama-fim-client';
import { postprocessFimCompletion } from '../src/node/fim-module/model-call/postprocess';
import { verifyAixcoderSpecialTokens } from '../src/node/aixcoder/aixcoder-token-healthcheck';

const ENABLED = process.env.SC_AIX_IT === '1';
const BASE_URL = process.env.SC_AIX_URL ?? process.env.SC_FIM_URL ?? 'http://127.0.0.1:8020/v1';
const LEAKED_TOKENS = /<\|(fim_prefix|fim_suffix|fim_middle|fim_pad|repo_name|file_sep|filename|reponame|endoftext|end_of_text)\|>|<｜fim▁(begin|hole|end)｜>|<\/s>|▁<AIX-SPAN-(PRE|POST|MIDDLE)>/;
const CODE_FENCE = /```/;

const client = new LlamaFimClient();

async function runAixcoder(prefix: string, suffix: string, neighbors: Neighbor[]): Promise<string> {
    const prompt = buildFimPrompt({
        modelId: 'aixcoder-7b-v2',
        languageId: 'typescript',
        fileMode: 'code',
        prefix,
        suffix,
        generationMode: 'multiline',
        contextSize: 8192,
        filePath: 'src/demo.ts',
        neighbors,
    });
    const raw = await client.complete({
        baseUrl: BASE_URL,
        model: prompt.llamaModel,
        prompt: prompt.prompt,
        stop: prompt.stop,
        maxTokens: prompt.maxTokens,
        temperature: 0,
    });
    return postprocessFimCompletion(raw, { suffix, generationMode: 'multiline', stopTokens: prompt.stop });
}

test(
    'aiXcoder live: GGUF preserves AIX-SPAN special tokens',
    { skip: !ENABLED && 'set SC_AIX_IT=1 to run', timeout: 120000 },
    async () => {
        assert.equal(await verifyAixcoderSpecialTokens(BASE_URL), true);
    },
);

test(
    'aiXcoder live: repo-context round-trip returns a clean completion span',
    { skip: !ENABLED && 'set SC_AIX_IT=1 to run', timeout: 120000 },
    async () => {
        const text = await runAixcoder(
            'import { square } from "./math";\n\nexport function squareSum(a: number, b: number): number {\n    return ',
            '\n}',
            [{
                filePath: 'src/math.ts',
                startLine: 1,
                endLine: 3,
                text: 'export function square(n: number): number {\n    return n * n;\n}',
                score: 1,
            }],
        );

        assert.ok(text.length > 0, 'expected a non-empty completion');
        assert.ok(!LEAKED_TOKENS.test(text), `completion leaked aiXcoder tokens: ${JSON.stringify(text)}`);
        assert.ok(!CODE_FENCE.test(text), `completion contains a markdown fence: ${JSON.stringify(text)}`);
    },
);
