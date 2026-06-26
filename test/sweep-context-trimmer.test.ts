import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimSweepContext } from '../src/node/sweep/data-formatting-layer/context-trimmer';
import type { TokenCounter } from '../src/node/sweep/token-budget/token-counter';

/** Детерминированный счётчик делает token budget тест независимым от transformers.js tokenizer. */
const charCounter: TokenCounter = {
    mode: 'char-fallback',
    async ensureReady(): Promise<void> {},
    count(text: string): number {
        return text.length;
    },
};

/** Проверяет приоритет: local error сохраняется, recent edit не вытесняется дальней error diagnostic. */
test('trimSweepContext keeps local errors and recent edits before distant errors', () => {
    const trimmed = trimSweepContext({
        modelId: 'sweep-default',
        filePath: 'src/a.ts',
        fileMode: 'code',
        windowText: 'const value = 1;\n',
        originalWindowText: 'const value = 1;\n',
        cursorOffset: 6,
        windowStartLine: 10,
        recentEdits: [{
            uri: 'src/types.ts',
            unifiedDiff: '@@ -1,1 +1,1 @@\n-oldName\n+newName\ncontext line\n',
            timestamp: 10,
        }],
        diagnostics: [
            {
                range: { start: { line: 10, character: 6 }, end: { line: 10, character: 11 } },
                severity: 'error',
                message: 'near error',
            },
            {
                range: { start: { line: 100, character: 0 }, end: { line: 100, character: 1 } },
                severity: 'error',
                message: 'distant error '.repeat(16),
            },
        ],
        editVolume: 'small',
        contextSize: 384,
        tokenCounter: charCounter,
    }, 128);

    assert.equal(trimmed.recentEdits.length, 1);
    assert.deepEqual(trimmed.diagnostics.map(diagnostic => diagnostic.message), ['near error']);
    assert.equal(typeof trimmed.consumedTokens, 'number');
    assert.ok(trimmed.consumedTokens >= 0);
});
