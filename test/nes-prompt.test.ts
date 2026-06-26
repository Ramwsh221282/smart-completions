import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNesPrompt, formatRecentEdits } from '../src/node/nes-module/context-formation/builder';
import { buildSweepPrompt, unifiedDiffToOriginalUpdated } from '../src/node/sweep/prompt-creating-layer/sweep-prompt-builder';
import { RecentEdit } from '../src/common/edit-history-types';
import { reconstructOriginalWindow } from '../src/common/sweep/original-window-reconstruction';

const recentEdits: RecentEdit[] = [{
    uri: 'src/a.ts',
    unifiedDiff: '--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-old\n+new',
    timestamp: 1,
}];

/** Достаёт хвост из трёх последних <|file_sep|> блоков. */
function lastThreeBlocks(prompt: string): string[] {
    return prompt.split('<|file_sep|>').filter(Boolean).slice(-3);
}

test('sweep prompt ends with the original/current/updated triad in that exact order', () => {
    const built = buildSweepPrompt({
        modelId: 'sweep-default',
        filePath: 'src/a.ts',
        windowText: 'const value = 1;',
        cursorOffset: 12,
        windowStartLine: 9,
        recentEdits,
        editVolume: 'medium',
    });

    const triad = lastThreeBlocks(built.prompt);
    assert.ok(triad[0].startsWith('original/src/a.ts:10:10'), 'original/ is third-to-last');
    assert.ok(triad[1].startsWith('current/src/a.ts:10:10'), 'current/ is second-to-last');
    assert.ok(triad[2].startsWith('updated/src/a.ts:10:10'), 'updated/ is last');
    assert.ok(built.prompt.includes('current/src/a.ts:10:10\nconst value <|cursor|>= 1;'));
    assert.equal(built.format, 'sweep');
    assert.equal(built.maxTokens, 768);
});

test('sweep prompt updated/ block closes the prompt', () => {
    const built = buildSweepPrompt({
        modelId: 'sweep-default',
        filePath: 'src/a.ts',
        windowText: 'const value = 1;',
        cursorOffset: 12,
        recentEdits,
        editVolume: 'medium',
    });
    const lastBlock = built.prompt.slice(built.prompt.lastIndexOf('<|file_sep|>'));
    assert.ok(lastBlock.startsWith('<|file_sep|>updated/src/a.ts'), 'updated/ closes the prompt');
});

test('sweep prompt drops legacy context/* sections and the hardcoded instruction', () => {
    const built = buildSweepPrompt({
        modelId: 'sweep-default',
        filePath: 'src/a.ts',
        windowText: 'const value = 1;',
        cursorOffset: 12,
        recentEdits,
        editVolume: 'medium',
    });
    assert.ok(!built.prompt.includes('context/rules'), 'no hardcoded instruction');
    assert.ok(!built.prompt.includes('context/retrieval'));
    assert.ok(!built.prompt.includes('context/diagnostics'));
    assert.ok(!built.prompt.includes('recent_changes'));
    assert.ok(!built.prompt.includes('Rewrite the current window'));
});

test('sweep recent changes render as native {path}.diff with original/updated states', () => {
    const built = buildSweepPrompt({
        modelId: 'sweep-default',
        filePath: 'src/a.ts',
        windowText: 'const value = 1;',
        cursorOffset: 12,
        recentEdits,
        editVolume: 'medium',
    });
    assert.ok(built.prompt.includes('<|file_sep|>src/a.ts.diff\noriginal:\nold\nupdated:\nnew'));
});

test('sweep retrieval neighbors render as native file blocks before the triad', () => {
    const built = buildSweepPrompt({
        modelId: 'sweep-default',
        filePath: 'src/a.ts',
        windowText: 'const value = 1;',
        cursorOffset: 12,
        recentEdits,
        neighbors: [{ filePath: 'src/dep.ts', startLine: 1, endLine: 2, text: 'export const dep = 1;', score: 0.9 }],
        editVolume: 'medium',
    });
    assert.ok(built.prompt.includes('<|file_sep|>src/dep.ts\nexport const dep = 1;'));
    assert.ok(built.prompt.indexOf('src/dep.ts\nexport const dep') < built.prompt.indexOf('current/src/a.ts'));
});

test('sweep broad current file block is first when present', () => {
    const built = buildSweepPrompt({
        modelId: 'sweep-default',
        filePath: 'src/a.ts',
        windowText: 'const value = 1;',
        broadFileText: 'import { dep } from "./dep";\nconst value = 1;',
        cursorOffset: 12,
        recentEdits,
        editVolume: 'medium',
    });
    assert.ok(built.prompt.startsWith('<|file_sep|>src/a.ts\nimport { dep } from "./dep";'));
    assert.ok(built.prompt.indexOf('<|file_sep|>src/a.ts\n') < built.prompt.indexOf('<|file_sep|>src/a.ts.diff'));
});

test('sweep diagnostics go into a diagnostics/{file} pseudo-file, error before warning', () => {
    const built = buildSweepPrompt({
        modelId: 'sweep-default',
        filePath: 'src/a.ts',
        windowText: 'broken();\nmore();',
        cursorOffset: 3,
        recentEdits,
        editVolume: 'medium',
        diagnostics: [
            {
                range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
                severity: 'warning',
                message: 'unused variable more',
            },
            {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
                severity: 'error',
                message: 'Cannot find name broken',
            },
        ],
    });

    assert.ok(built.prompt.includes('<|file_sep|>diagnostics/src/a.ts'), 'diagnostics are a pseudo-file');
    const diagSection = built.prompt.slice(built.prompt.indexOf('diagnostics/src/a.ts'));
    const errIndex = diagSection.indexOf('Cannot find name broken');
    const warnIndex = diagSection.indexOf('unused variable more');
    assert.ok(errIndex >= 0 && warnIndex >= 0, 'both diagnostics present');
    assert.ok(errIndex < warnIndex, 'error is listed before warning');
    assert.ok(diagSection.includes('Line 1: Cannot find name broken'), 'diagnostic carries a 1-based line');
});

test('sweep info/hint diagnostics are filtered out', () => {
    const built = buildSweepPrompt({
        modelId: 'sweep-default',
        filePath: 'src/a.ts',
        windowText: 'const value = 1;',
        cursorOffset: 5,
        recentEdits,
        editVolume: 'medium',
        diagnostics: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
            severity: 'info',
            message: 'consider const assertion',
        }],
    });
    assert.ok(!built.prompt.includes('diagnostics/src/a.ts'), 'no error/warning => no diagnostics pseudo-file');
});

test('sweep prose prompt omits diagnostics pseudo-file', () => {
    const built = buildSweepPrompt({
        modelId: 'sweep-default',
        filePath: 'README.md',
        fileMode: 'prose',
        windowText: 'old sentence.',
        cursorOffset: 3,
        recentEdits,
        editVolume: 'medium',
        diagnostics: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            severity: 'error',
            message: 'markdown diagnostic',
        }],
    });
    assert.ok(!built.prompt.includes('diagnostics/README.md'));
    assert.ok(built.prompt.includes('<|file_sep|>current/README.md'));
});

test('sweep diagnostics disabled when injectInlineDiagnostics is false', () => {
    const built = buildSweepPrompt({
        modelId: 'sweep-small',
        filePath: 'src/a.ts',
        windowText: 'broken()',
        cursorOffset: 8,
        recentEdits,
        editVolume: 'small',
        injectInlineDiagnostics: false,
        diagnostics: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
            severity: 'error',
            message: 'Cannot find name broken',
        }],
    });
    assert.ok(!built.prompt.includes('diagnostics/src/a.ts'));
    assert.equal(built.model, 'sweep-next-edit-1.5B');
});

test('sweep original/ block uses the window-before snapshot when provided', () => {
    const built = buildSweepPrompt({
        modelId: 'sweep-default',
        filePath: 'src/a.ts',
        windowText: 'const value = 2;',
        originalWindowText: 'const value = 1;',
        cursorOffset: 12,
        windowStartLine: 0,
        recentEdits,
        editVolume: 'medium',
    });
    assert.ok(built.prompt.includes('<|file_sep|>original/src/a.ts:1:1\nconst value = 1;'));
    assert.ok(built.prompt.includes('<|file_sep|>current/src/a.ts:1:1\nconst value <|cursor|>= 2;'));
});

test('sweep original reconstruction reverses the latest intersecting edit', () => {
    const reconstructed = reconstructOriginalWindow('const value = 2;', 0, 'file:///src/a.ts', [{
        uri: 'file:///src/a.ts',
        unifiedDiff: '--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-const value = 1;\n+const value = 2;',
        timestamp: 10,
    }]);
    assert.equal(reconstructed, 'const value = 1;');
});

test('sweep outline and output render as pseudo-files in zone B', () => {
    const built = buildSweepPrompt({
        modelId: 'sweep-default',
        filePath: 'src/a.ts',
        windowText: 'const value = 1;',
        cursorOffset: 5,
        recentEdits,
        editVolume: 'medium',
        outline: 'class A [1:0-3:1]\n  m [2:2-2:9] <-- cursor',
        outputSnippets: [{ channel: 'build', text: 'ERROR src/a.ts:1: boom' }],
    });
    assert.ok(built.prompt.includes('<|file_sep|>outline/src/a.ts\nclass A [1:0-3:1]'));
    assert.ok(built.prompt.includes('<|file_sep|>output/build\nERROR src/a.ts:1: boom'));
});

test('zeta prompt uses fim sections and current region marker', () => {
    const built = buildNesPrompt({
        modelId: 'zeta',
        filePath: 'src/a.ts',
        windowText: 'abc',
        cursorOffset: 1,
        recentEdits,
        editVolume: 'large',
    });

    assert.ok(built.prompt.startsWith('<[fim-prefix]>'));
    assert.ok(built.prompt.includes('<<<<<<< CURRENT'));
    assert.ok(built.prompt.includes('a<|cursor|>bc'));
    assert.equal(built.format, 'zeta');
    assert.equal(built.maxTokens, 512);
});

test('formatRecentEdits strips file headers from stored diffs', () => {
    const formatted = formatRecentEdits(recentEdits);
    assert.ok(!formatted.includes('--- a.ts'));
    assert.ok(formatted.includes('@@ -1,1 +1,1 @@'));
});

test('unifiedDiffToOriginalUpdated splits removed and added lines', () => {
    const { original, updated } = unifiedDiffToOriginalUpdated(
        '--- a.ts\n+++ a.ts\n@@ -1,2 +1,2 @@\n context\n-removed\n+added',
    );
    assert.equal(original, 'context\nremoved');
    assert.equal(updated, 'context\nadded');
});
