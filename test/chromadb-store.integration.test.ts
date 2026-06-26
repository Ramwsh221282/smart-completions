import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChromaVectorStore } from '../src/node/embedding-module/vector-store/chromadb-store';
import { ChunkRecord } from '../src/node/embedding-module/vector-store/iface';

// Idempotent интеграционный тест ChromaDB: поднимает сервер (uvx), тестирует, гасит.
// Гейт: запускается только при SC_CHROMA_IT=1 (требует uvx + chromadb в окружении).
const ENABLED = process.env.SC_CHROMA_IT === '1';

function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(url);
            if (res.ok) {
                return true;
            }
        } catch {
            /* ещё не готов */
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    return false;
}

function rec(id: string, filePath: string, vector: number[], text: string): ChunkRecord {
    return { id, filePath, startLine: 1, endLine: 2, language: 'ts', nodeType: 'function_declaration', text, vector };
}

test(
    'chromadb store integration (spin up → test → tear down)',
    { skip: !ENABLED && 'set SC_CHROMA_IT=1 to run', timeout: 200000 },
    async () => {
        const port = await getFreePort();
        const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sc-chroma-data-'));
        let child: ChildProcess | undefined;
        try {
            child = spawn(
                'uvx',
                ['--from', 'chromadb', 'chroma', 'run', '--path', dataDir, '--port', String(port), '--host', '127.0.0.1'],
                { detached: true, stdio: 'ignore' },
            );
            const ready = await waitForHttp(`http://127.0.0.1:${port}/api/v2/heartbeat`, 160000);
            assert.ok(ready, 'chroma server became ready');

            const store = new ChromaVectorStore(`http://127.0.0.1:${port}`);
            await store.init();
            await store.clear();

            await store.upsert([
                rec('1', 'a.ts', [1, 0, 0], 'alpha function'),
                rec('2', 'b.ts', [0, 1, 0], 'beta function'),
                rec('3', 'a.ts', [0.9, 0.1, 0], 'alpha helper'),
            ]);
            assert.equal(await store.count(), 3);

            const hits = await store.vectorSearch([1, 0, 0], 2);
            assert.ok(hits.length >= 1);
            assert.equal(hits[0].record.id, '1', 'nearest vector is id 1');

            const all = await store.getAll();
            assert.equal(all.length, 3);

            await store.removeByFile('a.ts');
            assert.equal(await store.count(), 1, 'only b.ts remains');

            await store.clear();
            assert.equal(await store.count(), 0);
            await store.dispose();
        } finally {
            if (child && child.pid) {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                } catch {
                    try {
                        child.kill('SIGKILL');
                    } catch {
                        /* already dead */
                    }
                }
            }
            await fs.promises.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
        }
    },
);
