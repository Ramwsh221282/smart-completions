import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BetterSqlite3GraphStore, SymbolRow } from '../src/node/sweep/retrieval/graph/sweep-graph-store';

/** Создаёт детерминированную symbol row для проверки SQLite round-trip без parser-зависимости. */
function symbol(name: string, file: string, startLine: number): SymbolRow {
    return { name, kind: 'function', file, startLine, endLine: startLine + 2, body: `function ${name}() { return true; }` };
}

/** Проверяет CRUD и persistence свойства better-sqlite3 graph store. */
test('BetterSqlite3GraphStore stores symbols refs and survives reopen', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sc-graph-store-'));
    const dbPath = path.join(dir, 'graph.sqlite');
    const store = new BetterSqlite3GraphStore(dbPath);
    store.insertSymbols([symbol('getUserName', 'src/user.ts', 3), symbol('Order', 'src/order.ts', 10)]);
    store.insertRefs([{ name: 'getUserName', file: 'src/service.ts', line: 7 }]);

    assert.equal(store.declarationsByName('getUserName', 10)[0].file, 'src/user.ts');
    assert.equal(store.referencesToName('getUserName', 10)[0].line, 7);
    assert.deepEqual(store.namesReferencedByFile('src/service.ts', 10), ['getUserName']);
    assert.equal(store.symbolsContainingLine('src/user.ts', 4, 1)[0].name, 'getUserName');
    store.dispose();

    const reopened = new BetterSqlite3GraphStore(dbPath);
    assert.equal(reopened.declarationsByName('Order', 10)[0].file, 'src/order.ts');
    reopened.deleteFile('src/order.ts');
    assert.deepEqual(reopened.declarationsByName('Order', 10), []);
    reopened.dispose();
    await fs.promises.rm(dir, { recursive: true, force: true });
});
