import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    encodeFrame,
    fileModeToWire,
    modeToWire,
    toWireCompletionRequest,
    toWireConfigUpdate,
    toWireDocumentChange,
    toWireInitialDocument,
} from '../src/node/core/core-ipc-client';
import {
    decodeClientFramePayload,
    decodeServerFramePayload,
    encodeServerFramePayload,
} from '../src/node/core/core-flatbuffers';

test('initial document maps to snake_case wire fields', () => {
    const wire = toWireInitialDocument({
        uri: 'file:///a.ts',
        version: 2,
        languageId: 'typescript',
        filePath: 'a.ts',
        fileMode: 'code',
        kind: 'file',
        text: 'x',
    });

    assert.deepEqual(wire, {
        uri: 'file:///a.ts',
        version: 2,
        language_id: 'typescript',
        file_path: 'a.ts',
        file_mode: 'Code',
        kind: 'File',
        text: 'x',
    });
});

test('missing file path becomes null and prose maps to PascalCase', () => {
    const wire = toWireInitialDocument({
        uri: 'untitled:1',
        version: 1,
        languageId: 'markdown',
        fileMode: 'prose',
        kind: 'untitled',
        text: '',
    });

    assert.equal(wire.file_path, null);
    assert.equal(wire.file_mode, 'Prose');
    assert.equal(wire.kind, 'Untitled');
});

test('document change shifts monaco 1-based ranges to 0-based', () => {
    const wire = toWireDocumentChange({
        uri: 'file:///a.ts',
        fromVersion: 1,
        toVersion: 2,
        changes: [
            {
                range: { startLineNumber: 1, startColumn: 11, endLineNumber: 1, endColumn: 12 },
                rangeLength: 1,
                text: '2',
            },
        ],
    });

    assert.deepEqual(wire.changes[0], {
        range: { start_line: 0, start_col: 10, end_line: 0, end_col: 11 },
        range_length: 1,
        inserted_text: '2',
    });
});

test('mode helpers map to the wire enum spellings', () => {
    assert.equal(fileModeToWire('code'), 'Code');
    assert.equal(fileModeToWire('prose'), 'Prose');
    assert.equal(modeToWire('fim'), 'Fim');
    assert.equal(modeToWire('nes'), 'Nes');
});

test('completion request maps the full envelope schema fields', () => {
    const wire = toWireCompletionRequest({
        requestId: 7,
        mode: 'fim',
        modelId: 'qwen2.5-coder',
        uri: 'file:///a.ts',
        version: 3,
        languageId: 'typescript',
        fileMode: 'code',
        cursor: { lineNumber: 2, column: 9, offset: 27 },
        editableRegion: {
            start: { line: 1, character: 0 },
            end: { line: 3, character: 4 },
        },
        recentEditUris: ['file:///a.ts', 'file:///b.ts'],
        recentEdits: [
            { uri: 'file:///a.ts', unifiedDiff: 'diff-a', timestamp: 1 },
            { uri: 'file:///b.ts', unifiedDiff: 'diff-b', timestamp: 2 },
        ],
        originalWindowText: 'const value = 1;',
        diagnostics: [
            {
                range: {
                    start: { line: 1, character: 0 },
                    end: { line: 1, character: 3 },
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
                selectionRange: {
                    start: { line: 0, character: 9 },
                    end: { line: 0, character: 13 },
                },
            },
        ],
        relatedFileHints: [
            {
                path: 'src/dep.ts',
                source: 'search',
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
            fuzzySymbols: ['demoHelper'],
            retrievalSignalHints: ['cursor tail'],
        },
        configVersion: 11,
        configJson: '{"fim":true}',
    });

    assert.deepEqual(wire, {
        request_id: 7,
        mode: 'Fim',
        model_id: 'qwen2.5-coder',
        uri: 'file:///a.ts',
        version: 3,
        language_id: 'typescript',
        file_mode: 'Code',
        cursor: { line: 1, column: 8, offset: 27 },
        editable_region: {
            start_line: 1,
            start_col: 0,
            end_line: 3,
            end_col: 4,
        },
        recent_edit_uris: ['file:///a.ts', 'file:///b.ts'],
        recent_edits: [
            { uri: 'file:///a.ts', unified_diff: 'diff-a', timestamp: 1 },
            { uri: 'file:///b.ts', unified_diff: 'diff-b', timestamp: 2 },
        ],
        original_window_text: 'const value = 1;',
        diagnostics: [
            {
                range: { start_line: 1, start_col: 0, end_line: 1, end_col: 3 },
                severity: 1,
                message: 'warn',
                code: 'W1',
            },
        ],
        outline: [
            {
                name: 'demo',
                kind: 'function',
                range: { start_line: 0, start_col: 0, end_line: 2, end_col: 0 },
                selection_range: { start_line: 0, start_col: 9, end_line: 0, end_col: 13 },
            },
        ],
        related_file_hints: [
            {
                path: 'src/dep.ts',
                range: undefined,
                source: 'search',
                score_hint: 0.5,
            },
        ],
        signals: {
            symbol_at_cursor: 'demo',
            renamed_symbols: ['before', 'after'],
            imported_symbols: ['dep'],
            declared_types: ['User'],
            test_names: ['works'],
            diagnostic_symbols: ['MissingType'],
            fuzzy_symbols: ['demoHelper'],
            retrieval_signal_hints: ['cursor tail'],
        },
        config_version: 11,
        config_json: '{"fim":true}',
    });
});

test('config update maps directly to the wire payload', () => {
    assert.deepEqual(toWireConfigUpdate({ configVersion: 4, configJson: '{"core":true}' }), {
        config_version: 4,
        config_json: '{"core":true}',
    });
});

test('progress server frame round-trips through flatbuffers', () => {
    const payload = encodeServerFramePayload({ kind: 'Progress', requestId: 12, text: 'indexing 3/10' });

    assert.deepEqual(decodeServerFramePayload(payload), {
        kind: 'Progress',
        requestId: 12,
        text: 'indexing 3/10',
    });
});

test('encodeFrame prefixes a little-endian length and round-trips', () => {
    const frame = { kind: 'Cancel', data: { request_id: 5 } } as const;

    const buffer = encodeFrame(frame);
    const length = buffer.readUInt32LE(0);
    const payload = buffer.subarray(4);

    assert.equal(length, payload.length);
    assert.deepEqual(decodeClientFramePayload(payload), frame);
});
