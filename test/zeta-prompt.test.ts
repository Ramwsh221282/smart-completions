import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildZetaPrompt } from '../src/node/zeta21/prompt-creating-layer/zeta-prompt-builder';

const CANONICAL_PROMPT = readFileSync(path.resolve(process.cwd(), 'test/fixtures/zeta-canonical-prompt.txt'), 'utf8').trimEnd();

test('buildZetaPrompt matches canonical SPM training-format snapshot', () => {
    const built = buildZetaPrompt({
        targetPath: 'path/to/target_file.py',
        prefixBeforeRegion: 'code before editable region',
        windowText: 'code that\nneeds to\nbe rewritten',
        suffixText: 'code after editable region',
        cursorOffset: 'code that\nneeds to'.length,
        regions: [{ markerIndex: 1, startOffset: 0, endOffset: 'code that\nneeds to\nbe rewritten'.length }],
        relatedFiles: [{ filePath: 'related/file.py', content: 'related file content' }],
        editHistoryBlock: '<filename>edit_history\n--- a/some_file.py\n+++ b/some_file.py\n-old\n+new',
    });

    assert.equal(built.prompt, CANONICAL_PROMPT);
    assert.deepEqual(built.stop, ['<|endoftext|>', '<[fim-suffix]>', '<[fim-prefix]>']);
});

test('buildZetaPrompt still emits target block when related and edit_history are empty', () => {
    const built = buildZetaPrompt({
        targetPath: 'src/a.ts',
        prefixBeforeRegion: '',
        windowText: 'abc',
        suffixText: '',
        cursorOffset: 1,
        regions: [{ markerIndex: 1, startOffset: 0, endOffset: 3 }],
        relatedFiles: [],
        editHistoryBlock: '',
    });

    assert.ok(built.prompt.includes('<[fim-prefix]><filename>src/a.ts'));
    assert.ok(built.prompt.endsWith('<[fim-middle]>'));
});
