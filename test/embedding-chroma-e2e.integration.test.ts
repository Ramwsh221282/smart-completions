import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EmbeddingService } from '../src/node/embedding-module/embedding-service';
import { EmbedClient } from '../src/node/embedding-module/embed-client/llama-embed-client';
import { EmbeddingConfig } from '../src/common/embedding-types';

// Идемпотентный e2e: поднимает ChromaDB (uvx) на свободном порту, прогоняет
// EmbeddingService поверх него (индексация + retrieval), затем гасит сервер.
// Гейт: SC_CHROMA_IT=1. Порт :8000 не используется (там может работать NES-модель).
const ENABLED = process.env.SC_CHROMA_IT === '1';

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

test(
    'embedding-service e2e over real ChromaDB (spin up → index → retrieve → tear down)',
    { skip: !ENABLED && 'set SC_CHROMA_IT=1 to run', timeout: 200000 },
    async () => {
        const port = await getFreePort();
        const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sc-chroma-e2e-'));
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sc-chroma-repo-'));
        const storage = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sc-chroma-store-'));
        let child: ChildProcess | undefined;
        try {
            child = spawn(
                'uvx',
                ['--from', 'chromadb', 'chroma', 'run', '--path', dataDir, '--port', String(port), '--host', '127.0.0.1'],
                { detached: true, stdio: 'ignore' },
            );
            const ready = await waitForHttp(`http://127.0.0.1:${port}/api/v2/heartbeat`, 160000);
            assert.ok(ready, 'chroma server became ready');

            await fs.promises.writeFile(
                path.join(root, 'math.ts'),
                'export function computeTotalPrice(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}',
            );
            await fs.promises.writeFile(
                path.join(root, 'user.ts'),
                'export class UserRepository {\n  findUser(id: string) { return id; }\n}',
            );

            const config: EmbeddingConfig = {
                embedModel: 'nomic',
                llamaUrl: 'http://127.0.0.1:9',
                vectorDb: 'chromadb',
                chromaUrl: `http://127.0.0.1:${port}`,
                indexOnSave: true,
                indexOnOpen: true,
                chunkSize: 40,
                topN: 3,
                prefixTailChars: 200,
            };

            const svc = new EmbeddingService({ storageDir: storage, createEmbedClient: () => fakeEmbed });
            await svc.configure(config, [root]);
            await svc.rebuild();
            assert.equal(svc.getStatus().state, 'ready');

            const neighbors = await svc.retrieve('computeTotalPrice', 3);
            assert.ok(neighbors.length >= 1, 'retrieved at least one neighbor');
            assert.ok(
                neighbors.some(n => n.filePath.endsWith('math.ts') && n.text.includes('computeTotalPrice')),
                `expected math.ts in neighbors, got ${neighbors.map(n => n.filePath).join(',')}`,
            );
            await svc.dispose();
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
            await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined);
            await fs.promises.rm(storage, { recursive: true, force: true }).catch(() => undefined);
        }
    },
);
