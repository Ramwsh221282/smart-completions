import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    encodeFrame,
    fileModeToWire,
    modeToWire,
    toWireDocumentChange,
    toWireInitialDocument,
} from '../src/node/core/core-ipc-client';
import { decodeClientFramePayload } from '../src/node/core/core-flatbuffers';

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

test('encodeFrame prefixes a little-endian length and round-trips', () => {
    const frame = { kind: 'Cancel', data: { request_id: 5 } } as const;

    const buffer = encodeFrame(frame);
    const length = buffer.readUInt32LE(0);
    const payload = buffer.subarray(4);

    assert.equal(length, payload.length);
    assert.deepEqual(decodeClientFramePayload(payload), frame);
});
