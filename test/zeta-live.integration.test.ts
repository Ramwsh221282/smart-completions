import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlamaZetaClient } from '../src/node/zeta21/model-call-layer/llama-zeta-client';
import { parseZetaCompletion } from '../src/node/zeta21/model-call-layer/zeta-response-parser';
import { buildZetaPrompt } from '../src/node/zeta21/prompt-creating-layer/zeta-prompt-builder';

const ENABLED = process.env.SC_ZETA_IT === '1';
const BASE_URL = process.env.SC_ZETA_URL ?? 'http://127.0.0.1:8010';

test(
    'Zeta live: raw completion round-trip keeps marker protocol intact',
    { skip: !ENABLED && 'set SC_ZETA_IT=1 to run', timeout: 120000 },
    async () => {
        const built = buildZetaPrompt({
            targetPath: 'sample.ts',
            prefixBeforeRegion: 'function demo() {',
            windowText: '  return value',
            suffixText: '\n}',
            cursorOffset: '  return '.length,
            regions: [{ markerIndex: 1, startOffset: 0, endOffset: '  return value'.length }],
            relatedFiles: [],
            editHistoryBlock: '',
        });
        const client = new LlamaZetaClient();
        const raw = await client.complete({
            baseUrl: BASE_URL,
            model: 'zeta-2.1',
            prompt: built.prompt,
            stop: built.stop,
            maxTokens: 128,
            temperature: 0,
            cachePrompt: true,
            seed: 0,
        });
        const parsed = parseZetaCompletion({
            rawText: raw,
            windowText: '  return value',
            windowStart: { line: 0, character: 0 },
            regions: [{ markerIndex: 1, startOffset: 0, endOffset: '  return value'.length }],
            stopTokens: built.stop,
        });

        assert.ok(!raw.includes('<[fim-prefix]><[fim-middle]>'));
        assert.ok(parsed.status === 'edit' || parsed.status === 'no-edit' || parsed.status === 'rejected');
    },
);
