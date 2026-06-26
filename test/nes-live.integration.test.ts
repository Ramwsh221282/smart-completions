import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecentEdit } from '../src/common/edit-history-types';
import { LlamaSweepClient } from '../src/node/sweep/model-call-layer/llama-sweep-client';
import { parseSweepCompletion } from '../src/node/sweep/model-call-layer/sweep-response-parser';
import { buildSweepPrompt } from '../src/node/sweep/prompt-creating-layer/sweep-prompt-builder';

// Интеграция NES с живым llama.cpp сервером (по умолчанию Sweep2-7B на :8000).
// Гейт: SC_NES_IT=1. URL переопределяется через SC_NES_URL.
const ENABLED = process.env.SC_NES_IT === '1';
const BASE_URL = process.env.SC_NES_URL ?? 'http://localhost:8000/v1';

const client = new LlamaSweepClient();

test(
    'NES live: sweep proposes an edit driven by recent changes',
    { skip: !ENABLED && 'set SC_NES_IT=1 to run', timeout: 120000 },
    async () => {
        const windowText = 'const name = 1;\nconst ag = 2;\nconst city = 3;';
        const cursorOffset = windowText.indexOf('const ag') + 'const ag'.length;
        const recentEdits: RecentEdit[] = [
            {
                uri: 'file:///repo/user.ts',
                unifiedDiff: '@@ -1,1 +1,1 @@\n-const nam = 1;\n+const name = 1;',
                timestamp: 1,
            },
        ];
        const prompt = buildSweepPrompt({
            modelId: 'sweep-default',
            filePath: 'user.ts',
            windowText,
            cursorOffset,
            recentEdits,
            editVolume: 'medium',
            neighbors: [],
        });
        const raw = await client.complete({
            baseUrl: BASE_URL,
            model: prompt.model,
            prompt: prompt.prompt,
            stop: prompt.stop,
            maxTokens: prompt.maxTokens,
            temperature: 0,
        });
        const parsed = parseSweepCompletion({
            rawText: raw,
            oldWindowText: windowText,
            windowStart: { line: 10, character: 0 },
            stopTokens: prompt.stop,
        });
        assert.ok(parsed.edits.length >= 1, `expected at least one edit, raw=${JSON.stringify(raw)}`);
        const combined = parsed.edits.map(edit => edit.newText).join('');
        assert.match(combined, /age/, `expected edit to complete "ag" to "age", got: ${JSON.stringify(combined)}`);
        assert.ok(parsed.primaryRange, 'expected a primary range for the View Zone');
    },
);

test(
    'NES live: edit ranges land inside the document window',
    { skip: !ENABLED && 'set SC_NES_IT=1 to run', timeout: 120000 },
    async () => {
        const windowText = 'function greet(nm: string) {\n  return "hi " + nm;\n}';
        const cursorOffset = windowText.indexOf('nm') + 'nm'.length;
        const recentEdits: RecentEdit[] = [
            {
                uri: 'file:///repo/greet.ts',
                unifiedDiff: '@@ -1,1 +1,1 @@\n-function greet(n: string) {\n+function greet(nm: string) {',
                timestamp: 1,
            },
        ];
        const prompt = buildSweepPrompt({
            modelId: 'sweep-default',
            filePath: 'greet.ts',
            windowText,
            cursorOffset,
            recentEdits,
            editVolume: 'medium',
            neighbors: [],
        });
        const raw = await client.complete({
            baseUrl: BASE_URL,
            model: prompt.model,
            prompt: prompt.prompt,
            stop: prompt.stop,
            maxTokens: prompt.maxTokens,
            temperature: 0,
        });
        const windowStartLine = 5;
        const windowLines = windowText.split('\n').length;
        const parsed = parseSweepCompletion({
            rawText: raw,
            oldWindowText: windowText,
            windowStart: { line: windowStartLine, character: 0 },
            stopTokens: prompt.stop,
        });
        for (const edit of parsed.edits) {
            assert.ok(edit.range.start.line >= windowStartLine, 'edit starts at or after the window start');
            assert.ok(
                edit.range.end.line <= windowStartLine + windowLines,
                `edit ends within the window, got end line ${edit.range.end.line}`,
            );
        }
    },
);
