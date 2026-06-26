import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as monaco from '@theia/monaco-editor-core';
import type { RecentEdit } from '../src/common/edit-history-types';
import type { ZetaEditableRegion } from '../src/common/zeta21/types';
import { ZetaRequestBuilder, type ZetaRecentEditHistory, type ZetaSyntaxWindowResolver } from '../src/browser/zeta21/data-formatting-layer/zeta-request-builder';
import type { ResolvedSyntaxWindow } from '../src/browser/zeta21/data-formatting-layer/zeta-syntax-region-resolver';

const RECENT_EDITS: RecentEdit[] = [{
    uri: 'file:///repo/a.ts',
    unifiedDiff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new',
    timestamp: 1,
}];

test('ZetaRequestBuilder snapshot uses syntax-expanded window and multi-region bounds in code mode', async () => {
    const builder = new ZetaRequestBuilder({
        resolve: async () => ({
            prefixText: 'function demo() {\n',
            windowText: '  const value = 1;\n  return value;\n',
            suffixText: '}\n',
            windowStart: { line: 1, character: 0 },
            cursorOffset: '  const value = 1;\n  return '.length,
            syntacticBounds: [
                { start: 0, end: '  const value = 1;'.length },
                { start: '  const value = 1;\n'.length, end: '  const value = 1;\n  return value;'.length },
            ],
        } satisfies ResolvedSyntaxWindow),
    } satisfies ZetaSyntaxWindowResolver);
    const model = fakeModel('file:///repo/demo.ts', 'typescript', 'function demo() {\n  const value = 1;\n  return value;\n}\n');

    const snapshot = await builder.snapshot(model, fakePosition(3, 10), fakeHistory(), []);

    assert.ok(snapshot);
    assert.equal(snapshot.windowText, '  const value = 1;\n  return value;\n');
    assert.equal(snapshot.prefixText, 'function demo() {\n');
    assert.equal(snapshot.suffixText, '}\n');
    assert.equal(snapshot.regions.length, 2);
    assert.deepEqual(snapshot.regions, [
        { markerIndex: 1, startOffset: 0, endOffset: '  const value = 1;'.length },
        { markerIndex: 3, startOffset: '  const value = 1;\n'.length, endOffset: '  const value = 1;\n  return value;'.length },
    ] satisfies ZetaEditableRegion[]);
});

test('ZetaRequestBuilder snapshot falls back to the current line when syntax resolution is unavailable', async () => {
    const builder = new ZetaRequestBuilder({
        resolve: async () => undefined,
    } satisfies ZetaSyntaxWindowResolver);
    const model = fakeModel('file:///repo/demo.ts', 'typescript', 'first();\nsecond();\nthird();\n');

    const snapshot = await builder.snapshot(model, fakePosition(2, 4), fakeHistory(), []);

    assert.ok(snapshot);
    assert.equal(snapshot.windowText, 'second();');
    assert.equal(snapshot.regions.length, 1);
    assert.deepEqual(snapshot.regions[0], { markerIndex: 1, startOffset: 0, endOffset: 'second();'.length });
});

function fakeHistory(): ZetaRecentEditHistory {
    return {
        getRecentEdits(): RecentEdit[] {
            return RECENT_EDITS;
        },
    };
}

function fakeModel(uri: string, languageId: string, value: string): monaco.editor.ITextModel {
    const lineStarts = computeLineStarts(value);
    const getLineContent = (lineNumber: number): string => {
        const start = lineStarts[lineNumber - 1];
        const end = lineNumber < lineStarts.length ? lineStarts[lineNumber] - 1 : value.length;
        return value.slice(start, end);
    };
    const getOffsetAt = (position: { lineNumber: number; column: number }): number => lineStarts[position.lineNumber - 1] + position.column - 1;
    return {
        uri: { toString: () => uri },
        getLanguageId(): string {
            return languageId;
        },
        getValue(): string {
            return value;
        },
        getLineContent,
        getLineCount(): number {
            return lineStarts.length;
        },
        getLineMaxColumn(lineNumber: number): number {
            return getLineContent(lineNumber).length + 1;
        },
        getValueInRange(range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }): string {
            const start = getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
            const end = getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
            return value.slice(start, end);
        },
        getOffsetAt,
    } as unknown as monaco.editor.ITextModel;
}

function fakePosition(lineNumber: number, column: number): monaco.Position {
    return { lineNumber, column } as monaco.Position;
}

function computeLineStarts(text: string): number[] {
    const out = [0];
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10 && i + 1 < text.length) {
            out.push(i + 1);
        }
    }
    return out;
}
