import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Neighbor } from '../src/common/embedding-types';
import { buildFimPrompt } from '../src/node/fim-module/context-formation/builder';
import { LlamaFimClient } from '../src/node/fim-module/model-call/llama-fim-client';
import { postprocessFimCompletion } from '../src/node/fim-module/model-call/postprocess';
import { verifySeedSpecialTokens } from '../src/node/seedcoder/seed-token-healthcheck';

const ENABLED = process.env.SC_SEED_IT === '1';
const BASE_URL = process.env.SC_SEED_URL ?? 'http://127.0.0.1:8020/v1';
const FIM_TOKENS = /<\|(fim_prefix|fim_suffix|fim_middle|fim_pad|repo_name|file_sep|filename|reponame|endoftext|end_of_text)\|>|<｜fim▁(begin|hole|end)｜>|<\[(fim-(suffix|prefix|middle)|end▁of▁sentence)\]>|<\/s>|▁<AIX-SPAN-(PRE|POST|MIDDLE)>/;
const CODE_FENCE = /```/;

const client = new LlamaFimClient();

async function runSeed(prefix: string, suffix: string, neighbors: Neighbor[]): Promise<string> {
    const prompt = buildFimPrompt({
        modelId: 'seed-coder-8b',
        languageId: 'typescript',
        fileMode: 'code',
        prefix,
        suffix,
        generationMode: 'multiline',
        contextSize: 32768,
        filePath: 'src/seed-live.ts',
        neighbors,
    });
    const raw = await client.complete({
        baseUrl: BASE_URL,
        model: prompt.llamaModel,
        prompt: prompt.prompt,
        stop: prompt.stop,
        maxTokens: prompt.maxTokens,
        temperature: 0.05,
    });
    return postprocessFimCompletion(raw, { suffix, generationMode: 'multiline', stopTokens: prompt.stop });
}

test(
    'Seed live: GGUF preserves FIM special tokens',
    { skip: !ENABLED && 'set SC_SEED_IT=1 to run', timeout: 120000 },
    async () => {
        const ok = await verifySeedSpecialTokens(BASE_URL);
        assert.equal(ok, true);
    },
);

test(
    'Seed live: SPM prompt round-trip returns clean code',
    { skip: !ENABLED && 'set SC_SEED_IT=1 to run', timeout: 120000 },
    async () => {
        const neighbor: Neighbor = {
            filePath: 'src/math.ts',
            startLine: 1,
            endLine: 3,
            text: 'export function square(n: number): number {\n    return n * n;\n}',
            score: 1,
        };
        const text = await runSeed(
            'import { square } from "./math";\n\nexport function squareSum(a: number, b: number): number {\n    return ',
            '\n}',
            [neighbor],
        );

        assert.ok(text.length > 0, 'expected a non-empty completion');
        assert.ok(!FIM_TOKENS.test(text), `completion leaked FIM tokens: ${JSON.stringify(text)}`);
        assert.ok(!CODE_FENCE.test(text), `completion contains a markdown fence: ${JSON.stringify(text)}`);
    },
);
