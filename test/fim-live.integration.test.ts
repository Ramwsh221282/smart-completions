import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Neighbor } from '../src/common/embedding-types';
import { FimModelId, GenerationMode } from '../src/common/model-types';
import { buildFimPrompt } from '../src/node/fim-module/context-formation/builder';
import { LlamaFimClient } from '../src/node/fim-module/model-call/llama-fim-client';
import { postprocessFimCompletion } from '../src/node/fim-module/model-call/postprocess';

// Интеграция FIM с живым llama.cpp сервером (по умолчанию Granite на :8080).
// Гейт: SC_FIM_IT=1. URL/модель переопределяются через SC_FIM_URL / SC_FIM_MODEL.
const ENABLED = process.env.SC_FIM_IT === '1';
const BASE_URL = process.env.SC_FIM_URL ?? 'http://localhost:8080/v1';
const MODEL_ID = (process.env.SC_FIM_MODEL ?? 'qwen2.5-coder') as FimModelId;

const FIM_TOKENS = /<\|(fim_prefix|fim_suffix|fim_middle|fim_pad|repo_name|file_sep|filename|reponame|endoftext|end_of_text)\|>|<｜fim▁(begin|hole|end)｜>|<\[(fim-(suffix|prefix|middle)|end▁of▁sentence)\]>|<\/s>|▁<AIX-SPAN-(PRE|POST|MIDDLE)>/;
const CODE_FENCE = /```/;

const client = new LlamaFimClient();

async function runFim(
    prefix: string,
    suffix: string,
    generationMode: GenerationMode,
    neighbors: Neighbor[],
): Promise<string> {
    const prompt = buildFimPrompt({
        modelId: MODEL_ID,
        fileMode: 'code',
        prefix,
        suffix,
        generationMode,
        contextSize: 8192,
        repoName: 'demo-repo',
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
    return postprocessFimCompletion(raw, { suffix, generationMode, stopTokens: prompt.stop });
}

test(
    'FIM live: file-level multiline completion returns clean code',
    { skip: !ENABLED && 'set SC_FIM_IT=1 to run', timeout: 120000 },
    async () => {
        const text = await runFim(
            'export function fib(n: number): number {\n    if (n < 2) return n;\n    return ',
            '\n}',
            'multiline',
            [],
        );
        assert.ok(text.length > 0, 'expected a non-empty completion');
        assert.ok(!FIM_TOKENS.test(text), `completion leaked FIM tokens: ${JSON.stringify(text)}`);
        assert.ok(!CODE_FENCE.test(text), `completion contains a markdown fence: ${JSON.stringify(text)}`);
        assert.match(text, /fib\s*\(/, `expected recursive fib call, got: ${JSON.stringify(text)}`);
    },
);

test(
    'FIM live: line mode returns a single line',
    { skip: !ENABLED && 'set SC_FIM_IT=1 to run', timeout: 120000 },
    async () => {
        const text = await runFim('const total = ', ';\n', 'line', []);
        assert.ok(text.length > 0, 'expected a non-empty completion');
        assert.ok(!text.includes('\n'), `line mode must not contain newlines: ${JSON.stringify(text)}`);
        assert.ok(!FIM_TOKENS.test(text), `completion leaked FIM tokens: ${JSON.stringify(text)}`);
        assert.ok(!CODE_FENCE.test(text), `completion contains a markdown fence: ${JSON.stringify(text)}`);
    },
);

test(
    'FIM live: repo context with neighbors does not corrupt output',
    { skip: !ENABLED && 'set SC_FIM_IT=1 to run', timeout: 120000 },
    async () => {
        const neighbor: Neighbor = {
            filePath: 'src/math.ts',
            startLine: 1,
            endLine: 3,
            text: 'export function square(n: number): number {\n    return n * n;\n}',
            score: 1,
        };
        const text = await runFim(
            'import { square } from "./math";\n\nexport function squareSum(a: number, b: number): number {\n    return ',
            '\n}',
            'multiline',
            [neighbor],
        );
        assert.ok(text.length > 0, 'expected a non-empty completion');
        assert.ok(!FIM_TOKENS.test(text), `completion leaked FIM tokens: ${JSON.stringify(text)}`);
        assert.ok(!CODE_FENCE.test(text), `completion contains a markdown fence: ${JSON.stringify(text)}`);
    },
);
