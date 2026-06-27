import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCoreCompletionRequest } from '../src/common/core/core-request-mapping';

test('buildCoreCompletionRequest carries collected envelope fields and dedupes recent edit URIs', () => {
    const request = buildCoreCompletionRequest({
        requestId: 9,
        mode: 'fim',
        modelId: 'qwen2.5-coder',
        uri: 'file:///a.ts',
        version: 4,
        languageId: 'typescript',
        fileMode: 'code',
        cursor: { lineNumber: 3, column: 7, offset: 41 },
        editableRegion: {
            start: { line: 1, character: 0 },
            end: { line: 3, character: 9 },
        },
        configVersion: 11,
        context: {
            recentEdits: [
                { uri: 'file:///a.ts', unifiedDiff: 'diff-a', timestamp: 1 },
                { uri: 'file:///b.ts', unifiedDiff: 'diff-b', timestamp: 2 },
                { uri: 'file:///a.ts', unifiedDiff: 'diff-c', timestamp: 3 },
            ],
            diagnostics: [
                {
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 3 },
                    },
                    severity: 'warning',
                    message: 'warn',
                    code: 'W1',
                },
            ],
            outline: [
                {
                    name: 'demo',
                    kind: 'function',
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 2, character: 0 },
                    },
                },
            ],
            relatedFileHints: [
                {
                    path: 'src/dep.ts',
                    source: 'definition',
                    scoreHint: 0.5,
                },
            ],
            signals: {
                symbolAtCursor: 'demo',
                renamedSymbols: ['before', 'after'],
                importedSymbols: ['dep'],
                declaredTypes: ['User'],
                testNames: ['works'],
                diagnosticSymbols: ['MissingType'],
                fuzzySymbols: [],
                retrievalSignalHints: [],
            },
        },
    });

    assert.deepEqual(request, {
        requestId: 9,
        mode: 'fim',
        modelId: 'qwen2.5-coder',
        uri: 'file:///a.ts',
        version: 4,
        languageId: 'typescript',
        fileMode: 'code',
        cursor: { lineNumber: 3, column: 7, offset: 41 },
        editableRegion: {
            start: { line: 1, character: 0 },
            end: { line: 3, character: 9 },
        },
        recentEditUris: ['file:///a.ts', 'file:///b.ts'],
        diagnostics: [
            {
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 3 },
                },
                severity: 'warning',
                message: 'warn',
                code: 'W1',
            },
        ],
        outline: [
            {
                name: 'demo',
                kind: 'function',
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 2, character: 0 },
                },
            },
        ],
        relatedFileHints: [
            {
                path: 'src/dep.ts',
                source: 'definition',
                scoreHint: 0.5,
            },
        ],
        signals: {
            symbolAtCursor: 'demo',
            renamedSymbols: ['before', 'after'],
            importedSymbols: ['dep'],
            declaredTypes: ['User'],
            testNames: ['works'],
            diagnosticSymbols: ['MissingType'],
            fuzzySymbols: [],
            retrievalSignalHints: [],
        },
        configVersion: 11,
        configJson: undefined,
    });
});
