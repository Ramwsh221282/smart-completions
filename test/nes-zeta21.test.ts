import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNesPrompt } from '../src/node/nes-module/context-formation/builder';
import { nesRetrievalQuery } from '../src/common/sweep/retrieval-queries';
import { parseNesCompletion } from '../src/node/nes-module/model-call/response-parser';
import { RecentEdit } from '../src/common/edit-history-types';
import { Neighbor } from '../src/common/embedding-types';

const recentEdits: RecentEdit[] = [{
    uri: 'file:///repo/a.ts',
    unifiedDiff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new',
    timestamp: 1,
}];

const neighbor: Neighbor = {
    filePath: 'src/dep.ts',
    startLine: 1,
    endLine: 2,
    text: 'export const dep = 1;',
    score: 0.9,
};

test('zeta-2.1 prompt fills native slots with markers and user cursor', () => {
    const built = buildNesPrompt({
        modelId: 'zeta-2.1',
        filePath: 'src/a.ts',
        windowText: 'abc',
        cursorOffset: 1,
        recentEdits,
        neighbors: [neighbor],
        editVolume: 'medium',
    });

    assert.equal(built.format, 'zeta-2.1');
    assert.ok(built.prompt.startsWith('<[fim-suffix]>\n<[fim-prefix]><filename>src/dep.ts'));
    assert.ok(built.prompt.includes('export const dep = 1;'));
    assert.ok(built.prompt.includes('<filename>edit_history\n--- a/a.ts'), 'edit_history keeps diff headers');
    assert.ok(built.prompt.includes('<filename>src/a.ts\n<|marker_1|>\na<|user_cursor|>bc\n<|marker_2|>'));
    assert.ok(built.prompt.endsWith('<[fim-middle]>'));
    assert.ok(built.stop.includes('<|marker_2|>'));
    assert.ok(!built.prompt.includes('<|cursor|>'), 'zeta-2.1 uses <|user_cursor|> not <|cursor|>');
    assert.equal(built.overflow, false);
    assert.equal(built.maxTokens, 256);
});

test('zeta-2.1 parser extracts region between markers and strips user cursor', () => {
    const parsed = parseNesCompletion({
        rawText: '<|marker_1|>\naXbc\n<|marker_2|>',
        oldWindowText: 'abc',
        windowStart: { line: 5, character: 0 },
        stopTokens: ['<|marker_2|>', '<[fim-suffix]>'],
    });

    assert.equal(parsed.edits.length, 1);
    assert.equal(parsed.edits[0].newText, 'aXbc');
    const combined = parsed.edits.map(edit => edit.newText).join('');
    assert.ok(!combined.includes('<|user_cursor|>'));
    assert.ok(!combined.includes('<|marker_1|>'));
});

test('nesRetrievalQuery uses recent edit diffs, newest at the tail', () => {
    const edits: RecentEdit[] = [
        { uri: 'file:///r/old.ts', unifiedDiff: 'OLD_DIFF_RENAME_foo', timestamp: 1 },
        { uri: 'file:///r/new.ts', unifiedDiff: 'NEW_DIFF_RENAME_bar', timestamp: 2 },
    ];
    const query = nesRetrievalQuery(edits, 1000);
    assert.ok(query.includes('OLD_DIFF_RENAME_foo'));
    assert.ok(query.includes('NEW_DIFF_RENAME_bar'));
    assert.ok(query.endsWith('NEW_DIFF_RENAME_bar'), 'newest edit ends the query tail');

    const tail = nesRetrievalQuery(edits, 10);
    assert.equal(tail.length, 10);
    assert.ok(tail.endsWith('bar'));
});

test('NES trimming drops RAG neighbors first when context window is tight', () => {
    const bigNeighbor: Neighbor = {
        filePath: 'src/big.ts',
        startLine: 1,
        endLine: 200,
        text: 'X'.repeat(5000),
        score: 0.9,
    };
    const built = buildNesPrompt({
        modelId: 'sweep-default',
        filePath: 'src/a.ts',
        windowText: 'const a = 1;',
        cursorOffset: 8,
        recentEdits,
        neighbors: [bigNeighbor],
        editVolume: 'medium',
        contextSize: 256,
    });

    assert.ok(!built.prompt.includes('X'.repeat(100)), 'oversized neighbor is dropped under tight budget');
    assert.ok(built.prompt.includes('const a <|cursor|>= 1;'), 'current window is preserved');
    assert.ok(built.prompt.includes('original:\nold\nupdated:\nnew'), 'recent edit diff is preserved over neighbors');
    assert.equal(built.overflow, false);
});

test('NES marks overflow when the editable window is empty', () => {
    const built = buildNesPrompt({
        modelId: 'sweep-default',
        filePath: 'src/a.ts',
        windowText: '   \n  ',
        cursorOffset: 0,
        recentEdits,
        editVolume: 'medium',
        contextSize: 8192,
    });
    assert.equal(built.overflow, true);
});

test('zeta-2.1 prompt without neighbors still emits edit_history and target slots', () => {
    const built = buildNesPrompt({
        modelId: 'zeta-2.1',
        filePath: 'src/a.ts',
        windowText: 'abc',
        cursorOffset: 0,
        recentEdits,
        neighbors: [],
        editVolume: 'small',
    });
    assert.ok(built.prompt.includes('<[fim-prefix]><filename>edit_history'));
    assert.ok(built.prompt.includes('<filename>src/a.ts\n<|marker_1|>'));
    assert.equal(built.maxTokens, 128);
});
