import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    fileModeForLanguage,
    toCoreDocumentChange,
    toCoreInitialSnapshot,
} from '../src/browser/core/document-sync-mapping';

test('markdown and plaintext are prose, other languages are code', () => {
    assert.equal(fileModeForLanguage('markdown'), 'prose');
    assert.equal(fileModeForLanguage('plaintext'), 'prose');
    assert.equal(fileModeForLanguage('typescript'), 'code');
});

test('initial snapshot marks the untitled scheme as a buffer', () => {
    const snapshot = toCoreInitialSnapshot({
        uri: 'untitled:1',
        version: 1,
        languageId: 'markdown',
        scheme: 'untitled',
        filePath: undefined,
        text: 'hi',
    });

    assert.equal(snapshot.kind, 'untitled');
    assert.equal(snapshot.fileMode, 'prose');
    assert.equal(snapshot.text, 'hi');
});

test('initial snapshot forwards optional relative file path', () => {
    const snapshot = toCoreInitialSnapshot({
        uri: 'file:///repo/src/a.ts',
        version: 2,
        languageId: 'typescript',
        scheme: 'file',
        filePath: 'src/a.ts',
        text: 'const a = 1;',
    });

    assert.equal(snapshot.filePath, 'src/a.ts');
    assert.equal(snapshot.kind, 'file');
});

test('document change derives from and to versions', () => {
    const change = toCoreDocumentChange('file:///a.ts', 5, [
        {
            range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
            rangeLength: 0,
            text: 'a',
        },
    ]);

    assert.equal(change.fromVersion, 4);
    assert.equal(change.toVersion, 5);
    assert.equal(change.changes[0].text, 'a');
});
