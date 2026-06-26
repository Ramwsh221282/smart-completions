import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EmbeddingService } from '../src/node/embedding-module/embedding-service';
import { EmbedClient } from '../src/node/embedding-module/embed-client/llama-embed-client';
import { EmbeddingConfig } from '../src/common/embedding-types';

// Детерминированный фейковый эмбеддер (стабильный ненулевой вектор из слов).
function fakeVector(text: string): number[] {
    const v = [0, 0, 0, 0, 0, 0, 0, 0];
    for (const tok of text.toLowerCase().match(/[a-z_]+/g) ?? []) {
        let h = 0;
        for (const c of tok) {
            h = (h * 31 + c.charCodeAt(0)) >>> 0;
        }
        v[h % v.length] += 1;
    }
    return v;
}
const fakeEmbed: EmbedClient = { async embed(inputs: string[]) { return inputs.map(fakeVector); } };

const config: EmbeddingConfig = {
    embedModel: 'nomic',
    llamaUrl: 'http://127.0.0.1:9',
    vectorDb: 'lancedb',
    indexOnSave: true,
    indexOnOpen: true,
    chunkSize: 40,
    topN: 3,
    prefixTailChars: 200,
};

test('embedding-service end-to-end: configure → rebuild → retrieve (real lancedb + fake embed)', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sc-es-'));
    const storage = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sc-es-store-'));
    await fs.promises.writeFile(
        path.join(root, 'math.ts'),
        'export function computeTotalPrice(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}',
    );
    await fs.promises.writeFile(
        path.join(root, 'user.ts'),
        'export class UserRepository {\n  findUser(id: string) { return id; }\n}',
    );

    const svc = new EmbeddingService({ storageDir: storage, createEmbedClient: () => fakeEmbed });
    await svc.configure(config, [root]);
    await svc.rebuild();
    assert.equal(svc.getStatus().state, 'ready');

    const neighbors = await svc.retrieve('computeTotalPrice', 3);
    assert.ok(neighbors.length >= 1, 'retrieved at least one neighbor');
    assert.ok(
        neighbors.some(n => n.filePath === 'math.ts' && n.text.includes('computeTotalPrice')),
        `expected math.ts in neighbors, got ${neighbors.map(n => n.filePath).join(',')}`,
    );
    await svc.dispose();
});
