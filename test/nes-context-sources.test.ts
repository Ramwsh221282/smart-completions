import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    symbolAtCursor,
    importedSymbols,
    declaredTypeNames,
    testNames,
    diagnosticSymbols,
    renamedSymbols,
} from '../src/common/sweep/signals';
import {
    buildSweepRetrievalQuery as buildNesRetrievalQuery,
    buildRelatedFileQueries,
} from '../src/common/sweep/retrieval-queries';
import {
    formatOutline,
    selectEnclosingRange,
    extractCodeSymbolsHeuristic,
    OutlineSymbol,
} from '../src/common/sweep/outline';
import { dedupeRankRelated } from '../src/common/sweep/related-files';
import { RecentEdit } from '../src/common/edit-history-types';

const edits: RecentEdit[] = [{
    uri: 'types.ts',
    unifiedDiff: '--- a/types.ts\n+++ b/types.ts\n@@ -1,1 +1,1 @@\n-    fullName: string;\n+    displayName: string;',
    timestamp: 1,
}];

test('symbolAtCursor returns identifier at or before the cursor', () => {
    const text = 'return user.fullName;';
    assert.equal(symbolAtCursor(text, text.indexOf('fullName') + 4), 'fullName');
    assert.equal(symbolAtCursor(text, text.indexOf('fullName')), 'fullName');
});

test('importedSymbols extracts named, default and require bindings', () => {
    const text = "import { User, Order as O } from './types';\nimport Repo from './repo';\nconst fs = require('fs');";
    const got = importedSymbols(text).sort();
    assert.deepEqual(got, ['O', 'Repo', 'User', 'fs'].sort());
});

test('declaredTypeNames and testNames extract declarations and test titles', () => {
    assert.deepEqual(declaredTypeNames('export interface User {}\nclass Repo {}'), ['User', 'Repo']);
    assert.deepEqual(testNames("describe('UserService', () => { it('returns name', () => {}); });"), ['UserService', 'returns name']);
});

test('diagnosticSymbols pulls quoted identifiers, last path segment', () => {
    const got = diagnosticSymbols([
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 'error', message: "Property 'fullName' does not exist. Did you mean 'displayName'?" },
    ]).sort();
    assert.deepEqual(got, ['displayName', 'fullName'].sort());
});

test('renamedSymbols surfaces added/removed identifiers from edit diffs', () => {
    const got = renamedSymbols(edits);
    assert.ok(got.includes('displayName'));
    assert.ok(got.includes('fullName'));
    assert.ok(!got.includes('string'), 'unchanged tokens are not reported');
});

test('buildNesRetrievalQuery leads with edit-signal symbols then diff tail', () => {
    const query = buildNesRetrievalQuery({
        recentEdits: edits,
        windowText: 'return user.fullName;',
        cursorOffset: 'return user.full'.length,
        diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 'error', message: "Did you mean 'displayName'?" }],
        maxChars: 4000,
    });
    assert.ok(query.includes('fullName'));
    assert.ok(query.includes('displayName'));
    assert.ok(query.length <= 4000);
});

test('buildNesRetrievalQuery respects the char budget', () => {
    const query = buildNesRetrievalQuery({ recentEdits: edits, windowText: 'fullName', cursorOffset: 4, maxChars: 5 });
    assert.ok(query.length <= 5);
});

test('buildRelatedFileQueries returns deduped non-empty signals', () => {
    const queries = buildRelatedFileQueries({
        recentEdits: edits,
        windowText: "import { User } from './types';\nreturn user.fullName;",
        cursorOffset: "import { User } from './types';\nreturn user.full".length,
        maxChars: 4000,
    });
    assert.ok(queries.includes('fullName'));
    assert.ok(queries.includes('User'));
    assert.equal(new Set(queries).size, queries.length, 'no duplicates');
});

const outline: OutlineSymbol[] = [{
    name: 'UserService', kind: 'class', startLine: 0, endLine: 12, startChar: 0,
    children: [
        { name: 'getUser', kind: 'method', startLine: 2, endLine: 4 },
        { name: 'getDisplayName', kind: 'method', startLine: 6, endLine: 9 },
    ],
}];

test('formatOutline renders a compact tree with cursor marker on deepest node', () => {
    const text = formatOutline(outline, 7);
    assert.ok(text.includes('UserService [1:0-13]'));
    assert.ok(/getDisplayName \[7-10\] <-- cursor/.test(text));
    assert.ok(!text.includes('getUser [3-5] <-- cursor'));
});

test('selectEnclosingRange picks the full method when it fits the window', () => {
    assert.deepEqual(selectEnclosingRange(outline, 7, 20), { startLine: 0, endLine: 12 });
    assert.deepEqual(selectEnclosingRange(outline, 7, 6), { startLine: 6, endLine: 9 });
    assert.equal(selectEnclosingRange(outline, 7, 2), undefined, 'nothing fits => fixed window');
});

test('extractCodeSymbolsHeuristic finds class and its methods', () => {
    const code = [
        'export class UserService {',
        '    getUser(id: string) {',
        '        return id;',
        '    }',
        '}',
    ].join('\n');
    const symbols = extractCodeSymbolsHeuristic(code);
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].name, 'UserService');
    assert.equal(symbols[0].endLine, 4);
    assert.ok(symbols[0].children?.some(c => c.name === 'getUser'));
});

test('dedupeRankRelated dedupes by path:lines and ranks by score, capped at top-N', () => {
    const related = dedupeRankRelated([
        { filePath: 'a.ts', content: 'A', startLine: 1, endLine: 2, score: 0.2 },
        { filePath: 'b.ts', content: 'B', startLine: 1, endLine: 2, score: 0.9 },
        { filePath: 'a.ts', content: 'A', startLine: 1, endLine: 2, score: 0.2 },
        { filePath: 'c.ts', content: '', score: 1 },
    ], 2);
    assert.deepEqual(related.map(r => r.filePath), ['b.ts', 'a.ts']);
});
