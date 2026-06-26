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

// Индексирование РЕАЛЬНОГО репозитория в живой ChromaDB и проверка retrieval.
// Гейт: SC_REPO_IT=1. Путь репозитория: SC_REPO_PATH (обязателен).
// llama.cpp embeddings недоступны, поэтому вектора даёт детерминированный embed-дублёр,
// а лексическая половина гибрида (BM25) работает по реальному тексту чанков.
const ENABLED = process.env.SC_REPO_IT === '1';
const REPO_PATH = process.env.SC_REPO_PATH ?? '';

// Детерминированный stand-in эмбеддера: хешированный bag-of-tokens высокой размерности,
// чтобы cosine ≈ лексическому пересечению (коллизии хешей пренебрежимо малы). Это не нейросеть,
// но даёт осмысленную векторную половину гибрида при отсутствии llama.cpp --embeddings.
const EMBED_DIM = 2048;
function embedText(text: string): number[] {
    const v = new Array(EMBED_DIM).fill(0);
    for (const tok of text.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []) {
        let h = 2166136261;
        for (const c of tok) {
            h = ((h ^ c.charCodeAt(0)) * 16777619) >>> 0;
        }
        v[h % EMBED_DIM] += 1;
    }
    return v;
}
const deterministicEmbed: EmbedClient = { async embed(inputs: string[]) { return inputs.map(embedText); } };

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
    'index the real repo into ChromaDB and retrieve relevant chunks',
    { skip: (!ENABLED && 'set SC_REPO_IT=1 to run') || (!REPO_PATH && 'set SC_REPO_PATH'), timeout: 240000 },
    async () => {
        assert.ok(fs.existsSync(REPO_PATH), `SC_REPO_PATH does not exist: ${REPO_PATH}`);
        const port = await getFreePort();
        const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sc-repo-chroma-'));
        const storage = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sc-repo-store-'));
        let child: ChildProcess | undefined;
        try {
            child = spawn(
                'uvx',
                ['--from', 'chromadb', 'chroma', 'run', '--path', dataDir, '--port', String(port), '--host', '127.0.0.1'],
                { detached: true, stdio: 'ignore' },
            );
            const ready = await waitForHttp(`http://127.0.0.1:${port}/api/v2/heartbeat`, 160000);
            assert.ok(ready, 'chroma server became ready');

            const config: EmbeddingConfig = {
                embedModel: 'nomic',
                llamaUrl: 'http://127.0.0.1:9',
                vectorDb: 'chromadb',
                chromaUrl: `http://127.0.0.1:${port}`,
                indexOnSave: true,
                indexOnOpen: true,
                chunkSize: 40,
                topN: 5,
                prefixTailChars: 400,
            };

            const svc = new EmbeddingService({ storageDir: storage, createEmbedClient: () => deterministicEmbed });
            await svc.configure(config, [REPO_PATH]);

            const startedAt = Date.now();
            await svc.rebuild();
            const indexMs = Date.now() - startedAt;
            const status = svc.getStatus();

            console.log(`[repo-index] root=${REPO_PATH}`);
            console.log(`[repo-index] state=${status.state} filesIndexed=${status.filesIndexed} totalFiles=${status.totalFiles} took=${indexMs}ms`);

            assert.equal(status.state, 'ready', `expected ready, got ${status.state} (${status.error ?? ''})`);
            assert.ok(status.filesIndexed > 5, `expected several indexed files, got ${status.filesIndexed}`);

            // Запросы — реалистичные фрагменты кода (как хвост префикса у FIM/NES), а не одно слово.
            const probes: Array<{ query: string; expectFile: string }> = [
                {
                    query: 'export function postprocessFimCompletion rawText options trimSuffixEcho leading newline generationMode',
                    expectFile: 'postprocess.ts',
                },
                {
                    query: 'class ChromaVectorStore implements VectorStore getOrCreateCollection queryEmbeddings nResults removeByFile file_path metadatas',
                    expectFile: 'chromadb-store.ts',
                },
                {
                    query: 'function parseNesCompletion diffWindows oldWindowText windowStart cleanResponse stopTokens primaryRange',
                    expectFile: 'response-parser.ts',
                },
                {
                    query: 'buildFimPrompt renderRepoPrompt normalizedNeighbors useRepoContext supportsRepoContext repoNameToken fileToken',
                    expectFile: 'builder.ts',
                },
            ];

            for (const probe of probes) {
                const neighbors = await svc.retrieve(probe.query, 5);
                console.log(`\n[query] ${probe.query}`);
                for (const n of neighbors) {
                    // filePath хранится относительно корня репозитория.
                    console.log(`   ${n.filePath}:${n.startLine}-${n.endLine} score=${n.score.toFixed(4)}`);
                }
                assert.ok(neighbors.length >= 1, `no neighbors for: ${probe.query}`);
                assert.ok(
                    neighbors.some(n => n.filePath.endsWith(probe.expectFile)),
                    `expected ${probe.expectFile} in top-5 for "${probe.query}", got ${neighbors.map(n => path.basename(n.filePath)).join(', ')}`,
                );
            }

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
            await fs.promises.rm(storage, { recursive: true, force: true }).catch(() => undefined);
        }
    },
);
