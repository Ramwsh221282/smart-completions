import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitIdentifier } from '../src/node/sweep/retrieval/fuzzy/identifier-tokenize';
import { SweepFuzzyChannel } from '../src/node/sweep/retrieval/fuzzy/sweep-fuzzy-channel';
import type { SymbolRow } from '../src/node/sweep/retrieval/graph/sweep-graph-store';

/** Создаёт symbol row для fuzzy tests с заполненным body, чтобы Neighbor text не был пустым. */
function symbol(name: string, file: string): SymbolRow {
    return { name, kind: 'function', file, startLine: 1, endLine: 3, body: `function ${name}() {}` };
}

/** Проверяет identifier splitting для camelCase и snake_case сигналов. */
test('splitIdentifier returns stable unique identifier parts', () => {
    assert.deepEqual(splitIdentifier('getUserName'), ['getUserName', 'get', 'User', 'Name']);
    assert.deepEqual(splitIdentifier('user_repository'), ['user_repository', 'user', 'repository']);
});

/** Проверяет fuzzy retrieve и incremental update/remove без полного rebuild. */
test('SweepFuzzyChannel retrieves symbols and updates one file incrementally', () => {
    const channel = new SweepFuzzyChannel();
    channel.rebuild([symbol('getUserName', 'src/user.ts'), symbol('createOrder', 'src/order.ts')]);

    assert.equal(channel.retrieve(['getUserName'], 5)[0].filePath, 'src/user.ts');
    assert.ok(channel.retrieve(['user'], 5).some(neighbor => neighbor.filePath === 'src/user.ts'));

    channel.updateFile('src/user.ts', [symbol('formatDisplayName', 'src/user.ts')]);
    assert.equal(channel.retrieve(['getUserName'], 5).some(neighbor => neighbor.text.includes('getUserName')), false);
    assert.equal(channel.retrieve(['formatDisplayName'], 5)[0].filePath, 'src/user.ts');

    channel.removeFile('src/user.ts');
    assert.equal(channel.retrieve(['formatDisplayName'], 5).length, 0);
});
