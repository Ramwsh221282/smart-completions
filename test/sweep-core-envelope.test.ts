import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSweepCoreContext } from '../src/browser/sweep/data-formatting-layer/sweep-core-envelope';

test('buildSweepCoreContext carries sweep signals, outline and related hints for core parity', () => {
    const context = buildSweepCoreContext(
        {
            windowText: 'import { dep } from "./dep";\nclass User {}\nconst value = dep;\n',
            windowStart: { line: 10, character: 0 },
            windowLineCount: 3,
            broadFileText: 'broad',
            broadFileStartLine: 0,
            originalWindowText: 'before',
            cursorOffset: 58,
            recentEdits: [
                { uri: 'file:///a.ts', unifiedDiff: '--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-oldName\n+newName', timestamp: 1 },
            ],
            diagnostics: [
                {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
                    severity: 'error',
                    message: 'Cannot find name "MissingType"',
                },
            ],
        },
        {
            relatedFiles: [{ filePath: 'src/dep.ts', content: 'export const dep = 1;' }],
            selectedRelatedCandidates: [
                { filePath: 'src/dep.ts', content: 'export const dep = 1;', startLine: 4, endLine: 8, score: 2 },
            ],
            outline: 'ignored string outline',
            outlineSymbols: [
                {
                    name: 'User',
                    kind: 'class',
                    startLine: 1,
                    endLine: 3,
                    startChar: 0,
                    children: [
                        {
                            name: 'getName',
                            kind: 'method',
                            startLine: 2,
                            endLine: 2,
                            startChar: 2,
                        },
                    ],
                },
            ],
        },
        4000,
    );

    assert.equal(context.originalWindowText, 'before');
    assert.deepEqual(context.recentEdits, [
        { uri: 'file:///a.ts', unifiedDiff: '--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-oldName\n+newName', timestamp: 1 },
    ]);
    assert.deepEqual(context.relatedFileHints, [
        {
            path: 'src/dep.ts',
            range: {
                start: { line: 4, character: 0 },
                end: { line: 8, character: 0 },
            },
            source: 'sweep-related',
            scoreHint: 2,
        },
    ]);
    assert.deepEqual(context.outline, [
        {
            name: 'User',
            kind: 'class',
            range: {
                start: { line: 1, character: 0 },
                end: { line: 3, character: 0 },
            },
            selectionRange: {
                start: { line: 1, character: 0 },
                end: { line: 1, character: 0 },
            },
        },
        {
            name: 'getName',
            kind: 'method',
            range: {
                start: { line: 2, character: 2 },
                end: { line: 2, character: 0 },
            },
            selectionRange: {
                start: { line: 2, character: 2 },
                end: { line: 2, character: 2 },
            },
        },
    ]);
    assert.deepEqual(context.signals, {
        symbolAtCursor: 'dep',
        renamedSymbols: ['newName', 'oldName'],
        importedSymbols: ['dep'],
        declaredTypes: ['User'],
        testNames: [],
        diagnosticSymbols: ['MissingType'],
        fuzzySymbols: undefined,
        retrievalSignalHints: ['dep', 'newName', 'oldName', 'MissingType', 'User'],
    });
});
