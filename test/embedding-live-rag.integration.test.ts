import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EmbeddingService } from '../src/node/embedding-module/embedding-service';
import { EmbeddingConfig, Neighbor } from '../src/common/embedding-types';
import { FimModelId } from '../src/common/model-types';
import { buildFimPrompt } from '../src/node/fim-module/context-formation/builder';
import { LlamaFimClient } from '../src/node/fim-module/model-call/llama-fim-client';
import { postprocessFimCompletion } from '../src/node/fim-module/model-call/postprocess';

// Полностью реальный пайплайн: живые эмбеддинги (llama.cpp) → ChromaDB → retrieval → RAG → FIM.
// Гейты: SC_EMBED_IT=1 + SC_REPO_PATH. Эндпоинты переопределяются через env.
const ENABLED = process.env.SC_EMBED_IT === '1';
const REPO_PATH = process.env.SC_REPO_PATH ?? '';
const EMBED_URL = process.env.SC_EMBED_URL ?? 'http://127.0.0.1:8090/v1';
const FIM_URL = process.env.SC_FIM_URL ?? 'http://127.0.0.1:8080/v1';
const FIM_MODEL = (process.env.SC_FIM_MODEL ?? 'granite-4.1-8b') as FimModelId;
const GRANITE_EMBED_MODEL = 'Qwen3-Embedding-0.6B';

const FIM_TOKENS = /<\|(fim_prefix|fim_suffix|fim_middle|fim_pad|repo_name|file_sep|filename|reponame|endoftext|end_of_text)\|>/;
const CODE_FENCE = /```/;

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
    'real embeddings + ChromaDB + RAG -> FIM end-to-end',
    {
        skip: (!ENABLED && 'set SC_EMBED_IT=1 to run') || (!REPO_PATH && 'set SC_REPO_PATH'),
        timeout: 360000,
    },
    async () => {
        assert.ok(fs.existsSync(REPO_PATH), `SC_REPO_PATH does not exist: ${REPO_PATH}`);

        // Эмбеддинг-эндпоинт должен отвечать осмысленным вектором.
        const probe = await fetch(`${EMBED_URL.replace(/\/$/, '')}/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: GRANITE_EMBED_MODEL, input: ['ping'] }),
        });
        assert.ok(probe.ok, `embedding endpoint not OK: ${probe.status}`);
        const probeJson = (await probe.json()) as { data?: Array<{ embedding: number[] }> };
        const dim = probeJson.data?.[0]?.embedding?.length ?? 0;
        console.log(`[embed] endpoint=${EMBED_URL} dim=${dim}`);
        assert.ok(dim > 0, 'embedding endpoint returned a vector');

        const port = await getFreePort();
        const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sc-live-chroma-'));
        const storage = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sc-live-store-'));
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
                embedModel: GRANITE_EMBED_MODEL,
                llamaUrl: EMBED_URL,
                vectorDb: 'chromadb',
                chromaUrl: `http://127.0.0.1:${port}`,
                indexOnSave: true,
                indexOnOpen: true,
                chunkSize: 40,
                topN: 5,
                prefixTailChars: 400,
            };

            // Реальный LlamaEmbedClient создаётся внутри EmbeddingService из config.llamaUrl.
            const svc = new EmbeddingService({ storageDir: storage });
            await svc.configure(config, [REPO_PATH]);

            const startedAt = Date.now();
            await svc.rebuild();
            const indexMs = Date.now() - startedAt;
            const status = svc.getStatus();
            console.log(`[index] state=${status.state} filesIndexed=${status.filesIndexed} took=${indexMs}ms`);
            assert.equal(status.state, 'ready', `expected ready, got ${status.state} (${status.error ?? ''})`);
            assert.ok(status.filesIndexed > 5, `expected several indexed files, got ${status.filesIndexed}`);

            // Гибридный retrieval: запросы с распознаваемыми терминами надёжны (вектор + BM25).
            const probes: Array<{ query: string; expectFile: string }> = [
                { query: 'normalize CRLF and lone CR to LF line endings', expectFile: 'crlf.ts' },
                { query: 'reciprocal rank fusion merge ranked lists into topN with k 60', expectFile: 'hybrid-retriever.ts' },
                { query: 'postprocess FIM completion strip leading newline and trim echoed suffix', expectFile: 'postprocess.ts' },
                { query: 'parse NES completion diff old and new window into line replacement', expectFile: 'response-parser.ts' },
            ];
            for (const probe of probes) {
                const neighbors = await svc.retrieve(probe.query, 5);
                console.log(`\n[query] ${probe.query}`);
                for (const n of neighbors) {
                    console.log(`   ${n.filePath}:${n.startLine}-${n.endLine} score=${n.score.toFixed(4)}`);
                }
                assert.ok(neighbors.length >= 1, `no neighbors for: ${probe.query}`);
                assert.ok(
                    neighbors.some(n => n.filePath.endsWith(probe.expectFile)),
                    `expected ${probe.expectFile} in top-5 for "${probe.query}", got ${neighbors.map(n => path.basename(n.filePath)).join(', ')}`,
                );
            }

            // Чисто семантический запрос (без общих идентификаторов) — печатаем для наблюдения.
            const semantic = await svc.retrieve('split source code into chunks per function and class', 5);
            console.log('\n[semantic] split source code into chunks per function and class');
            for (const n of semantic) {
                console.log(`   ${n.filePath}:${n.startLine}-${n.endLine} score=${n.score.toFixed(4)}`);
            }
            assert.ok(semantic.length >= 1, 'semantic query returned neighbors');

            // RAG -> FIM: реальные соседи из ChromaDB кормят реальный Granite.
            const fimPrefixTail = 'export function assembleFimPrompt(input: BuildFimPromptInput): BuiltFimPrompt {\n    return ';
            const ragNeighbors: Neighbor[] = await svc.retrieve('buildFimPrompt context formation repo slots renderRepoPrompt', 3);
            console.log(`\n[rag->fim] neighbors used: ${ragNeighbors.map(n => path.basename(n.filePath)).join(', ')}`);
            assert.ok(ragNeighbors.length >= 1, 'RAG produced neighbors for FIM');

            const prompt = buildFimPrompt({
                modelId: FIM_MODEL,
                languageId: 'typescript',
                fileMode: 'code',
                prefix: fimPrefixTail,
                suffix: '\n}',
                generationMode: 'multiline',
                contextSize: 8192,
                repoName: 'smart-completions',
                filePath: 'src/node/fim-module/context-formation/builder.ts',
                neighbors: ragNeighbors,
            });
            assert.ok(prompt.prompt.includes('// src/node/fim-module/context-formation/builder.ts\n'), 'current file block stays inside the stuffed prefix');
            assert.ok(!prompt.prompt.includes('<|reponame|>'), 'granite repo context no longer relies on undocumented repo tokens');
            assert.ok(!prompt.prompt.includes('<|filename|>'), 'granite repo context no longer relies on undocumented file tokens');

            const fimClient = new LlamaFimClient();
            const raw = await fimClient.complete({
                baseUrl: FIM_URL,
                model: prompt.llamaModel,
                prompt: prompt.prompt,
                stop: prompt.stop,
                maxTokens: prompt.maxTokens,
                temperature: 0,
            });
            const completion = postprocessFimCompletion(raw, { suffix: '\n}', generationMode: 'multiline', stopTokens: prompt.stop });
            console.log(`\n[rag->fim] Granite completion: ${JSON.stringify(completion)}`);
            assert.ok(completion.length > 0, 'RAG-fed FIM produced a non-empty completion');
            assert.ok(!FIM_TOKENS.test(completion), `completion leaked FIM tokens: ${JSON.stringify(completion)}`);
            assert.ok(!CODE_FENCE.test(completion), `completion contains a markdown fence: ${JSON.stringify(completion)}`);

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
