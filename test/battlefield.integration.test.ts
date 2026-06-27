import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EmbeddingService } from '../src/node/embedding-module/embedding-service';
import { EmbeddingConfig, Neighbor } from '../src/common/embedding-types';
import { FimModelId, NesModelId, VectorDbId } from '../src/common/model-types';
import { buildFimPrompt } from '../src/node/fim-module/context-formation/builder';
import { LlamaFimClient } from '../src/node/fim-module/model-call/llama-fim-client';
import { postprocessFimCompletion } from '../src/node/fim-module/model-call/postprocess';
import { buildSweepRetrievalQuery } from '../src/common/sweep/retrieval-queries';
import { extractCodeSymbolsHeuristic, formatOutline } from '../src/common/sweep/outline';
import { LlamaSweepClient } from '../src/node/sweep/model-call-layer/llama-sweep-client';
import { parseSweepCompletion } from '../src/node/sweep/model-call-layer/sweep-response-parser';
import { buildSweepPrompt } from '../src/node/sweep/prompt-creating-layer/sweep-prompt-builder';
import { buildNesPrompt } from '../src/node/nes-module/context-formation/builder';
import { parseNesCompletion } from '../src/node/nes-module/model-call/response-parser';
import { RecentEdit } from '../src/common/edit-history-types';

// Боевой прогон одной связки моделей: embedding-индекс → retrieval → FIM (no-RAG/with-RAG)
// → NES (no-RAG/with-RAG, diff-query). Пишет отчёт в test_results. Гейт: SC_BATTLE_IT=1 + SC_BATTLE_REPO.
// FIM-блок включается при SC_FIM_URL, NES-блок — при SC_NES_URL. Векторная БД пересоздаётся с нуля.
const ENABLED = process.env.SC_BATTLE_IT === '1';
const REPO = process.env.SC_BATTLE_REPO ?? '';

const EMBED_URL = process.env.SC_EMBED_URL ?? 'http://127.0.0.1:8090/v1';
const EMBED_MODEL = process.env.SC_EMBED_MODEL ?? 'granite';
const VECTOR_DB = (process.env.SC_VECTORDB ?? 'lancedb') as VectorDbId;
const EXTERNAL_CHROMA = process.env.SC_CHROMA_URL ?? '';

const FIM_URL = process.env.SC_FIM_URL ?? '';
const FIM_MODEL = (process.env.SC_FIM_MODEL ?? 'granite-4.1-8b') as FimModelId;
const FIM_CTX = Number(process.env.SC_FIM_CTX ?? '8192');

const NES_URL = process.env.SC_NES_URL ?? '';
const NES_MODEL = (process.env.SC_NES_MODEL ?? 'sweep-default') as NesModelId;
const NES_CTX = Number(process.env.SC_NES_CTX ?? '8192');
const NES_INJECT_DIAG = process.env.SC_NES_INJECT_DIAG === '1';

const FIM_TOKENS = /<\|(fim_prefix|fim_suffix|fim_middle|fim_pad|repo_name|file_sep|filename|reponame|endoftext|end_of_text)\|>|<｜fim▁(begin|hole|end)｜>|<\[(fim-(suffix|prefix|middle)|end▁of▁sentence)\]>|<\/s>|▁<AIX-SPAN-(PRE|POST|MIDDLE)>/;
const CODE_FENCE = /```/;
const NES_MARKER_LEAK = /<\|cursor\|>|<\|user_cursor\|>|<\|marker_\d+\|>|<<<<<<<|=======|>>>>>>>|<\|file_sep\|>/;
const LEGACY_NES_SECTIONS = ['context/rules', 'context/retrieval', 'context/diagnostics', 'recent_changes', 'Rewrite the current window'];

function isSweepModel(modelId: NesModelId): modelId is 'sweep-default' | 'sweep-small' {
    return modelId === 'sweep-default' || modelId === 'sweep-small';
}

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
            /* not ready */
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    return false;
}

function sanitize(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]+/g, '_');
}

interface BundleReport {
    runId: string;
    embedModel: string;
    embedDim: number;
    vectorDb: string;
    filesIndexed: number;
    indexMs: number;
    invariants: Array<{ name: string; ok: boolean; detail?: string }>;
    quality: Record<string, unknown>;
}

function record(report: BundleReport, name: string, ok: boolean, detail?: string): void {
    report.invariants.push({ name, ok, detail });
}

test(
    'battlefield: embedding index + retrieval + FIM/NES (no-RAG and with-RAG) bundle run',
    {
        skip: (!ENABLED && 'set SC_BATTLE_IT=1 to run') || (!REPO && 'set SC_BATTLE_REPO to the test_battlefield/repo path'),
        timeout: 600000,
    },
    async () => {
        assert.ok(fs.existsSync(REPO), `SC_BATTLE_REPO does not exist: ${REPO}`);
        const resultsRoot = process.env.SC_BATTLE_RESULTS ?? path.resolve(REPO, '..', '..', 'test_results');
        const runId = new Date().toISOString().replace(/[:.]/g, '-');
        const bundleName = [
            runId,
            `embed-${sanitize(EMBED_MODEL)}`,
            `db-${VECTOR_DB}`,
            `fim-${FIM_URL ? sanitize(FIM_MODEL) : 'none'}`,
            `nes-${NES_URL ? sanitize(NES_MODEL) : 'none'}`,
        ].join('__');
        const bundleDir = path.join(resultsRoot, bundleName);
        await fs.promises.mkdir(path.join(bundleDir, 'no_rag', 'raw_responses'), { recursive: true });
        await fs.promises.mkdir(path.join(bundleDir, 'no_rag', 'prompts'), { recursive: true });
        await fs.promises.mkdir(path.join(bundleDir, 'with_rag', 'raw_responses'), { recursive: true });
        await fs.promises.mkdir(path.join(bundleDir, 'with_rag', 'prompts'), { recursive: true });

        const report: BundleReport = {
            runId,
            embedModel: EMBED_MODEL,
            embedDim: 0,
            vectorDb: VECTOR_DB,
            filesIndexed: 0,
            indexMs: 0,
            invariants: [],
            quality: {},
        };

        // Embedding endpoint dim probe.
        const probe = await fetch(`${EMBED_URL.replace(/\/$/, '')}/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: EMBED_MODEL, input: ['ping'] }),
        });
        assert.ok(probe.ok, `embedding endpoint not OK: ${probe.status}`);
        const probeJson = (await probe.json()) as { data?: Array<{ embedding: number[] }> };
        report.embedDim = probeJson.data?.[0]?.embedding?.length ?? 0;
        assert.ok(report.embedDim > 0, 'embedding endpoint returned a vector');

        const storage = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sc-battle-store-'));
        let chroma: ChildProcess | undefined;
        let chromaUrl = EXTERNAL_CHROMA;

        try {
            if (VECTOR_DB === 'chromadb' && !chromaUrl) {
                const port = await getFreePort();
                const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sc-battle-chroma-'));
                chroma = spawn(
                    'uvx',
                    ['--from', 'chromadb', 'chroma', 'run', '--path', dataDir, '--port', String(port), '--host', '127.0.0.1'],
                    { detached: true, stdio: 'ignore' },
                );
                const ready = await waitForHttp(`http://127.0.0.1:${port}/api/v2/heartbeat`, 160000);
                assert.ok(ready, 'chroma server became ready');
                chromaUrl = `http://127.0.0.1:${port}`;
            }

            const config: EmbeddingConfig = {
                embedModel: EMBED_MODEL,
                llamaUrl: EMBED_URL,
                vectorDb: VECTOR_DB,
                chromaUrl: chromaUrl || undefined,
                indexOnSave: true,
                indexOnOpen: true,
                chunkSize: 40,
                topN: 5,
                prefixTailChars: 400,
            };

            // Чистое пересоздание БД и индекса под эту embedding-модель.
            const svc = new EmbeddingService({ storageDir: storage });
            await svc.configure(config, [REPO]);
            const startedAt = Date.now();
            await svc.rebuild();
            report.indexMs = Date.now() - startedAt;
            const status = svc.getStatus();
            report.filesIndexed = status.filesIndexed;
            record(report, 'index ready', status.state === 'ready', status.error);
            record(report, 'files indexed > 0', status.filesIndexed > 0, `filesIndexed=${status.filesIndexed}`);

            // Retrieval smoke по кросс-файловому термину.
            const retrievalNeighbors = await svc.retrieve('resolve user display name from user repository', 5);
            record(report, 'retrieval returns neighbors', retrievalNeighbors.length >= 1);
            await fs.promises.writeFile(
                path.join(bundleDir, 'retrieval_results.json'),
                JSON.stringify(retrievalNeighbors, null, 2),
            );

            // ===== FIM block =====
            if (FIM_URL) {
                const prefix =
                    "import { Currency } from './types';\n\n" +
                    'export function computeTotalPrice(items: number[]): number {\n' +
                    '    return items.reduce((sum, value) => sum + value, 0);\n}\n\n' +
                    'export function applyDiscount(total: number, percent: number): number {\n' +
                    '    const factor = 1 - percent / 100;\n    return ';
                const suffix = '\n}\n';
                const fimClient = new LlamaFimClient();

                for (const mode of ['no_rag', 'with_rag'] as const) {
                    const neighbors: Neighbor[] = mode === 'with_rag'
                        ? await svc.retrieve(prefix.slice(-400), 3)
                        : [];
                    const prompt = buildFimPrompt({
                        modelId: FIM_MODEL,
                        fileMode: 'code',
                        prefix,
                        suffix,
                        generationMode: 'multiline',
                        contextSize: FIM_CTX,
                        repoName: 'battlefield',
                        filePath: 'pricing.ts',
                        neighbors,
                    });
                    const raw = await fimClient.complete({
                        baseUrl: FIM_URL,
                        model: prompt.llamaModel,
                        prompt: prompt.prompt,
                        stop: prompt.stop,
                        maxTokens: prompt.maxTokens,
                        temperature: 0,
                    });
                    const completion = postprocessFimCompletion(raw, { suffix, generationMode: 'multiline', stopTokens: prompt.stop });
                    await fs.promises.writeFile(path.join(bundleDir, mode, 'prompts', 'fim.txt'), prompt.prompt);
                    await fs.promises.writeFile(path.join(bundleDir, mode, 'raw_responses', 'fim.txt'), raw);
                    await fs.promises.writeFile(
                        path.join(bundleDir, mode, 'fim_results.json'),
                        JSON.stringify({ modelId: FIM_MODEL, neighbors: neighbors.map(n => n.filePath), completion }, null, 2),
                    );
                    record(report, `FIM ${mode}: no token leak`, !FIM_TOKENS.test(completion), JSON.stringify(completion));
                    record(report, `FIM ${mode}: no code fence`, !CODE_FENCE.test(completion));
                    report.quality[`fim_${mode}_completion`] = completion;
                    if (mode === 'with_rag') {
                        record(report, 'FIM with_rag: neighbors fed', neighbors.length >= 1);
                    }
                }
            }

            // ===== NES block =====
            if (NES_URL) {
                const windowText = await fs.promises.readFile(path.join(REPO, 'user-service.ts'), 'utf8');
                const cursorOffset = windowText.indexOf('user.fullName') + 'user.fullName'.length;
                const recentEdits: RecentEdit[] = [{
                    uri: 'types.ts',
                    unifiedDiff:
                        '--- a/types.ts\n+++ b/types.ts\n@@ -1,5 +1,5 @@\n' +
                        ' export interface User {\n     id: string;\n' +
                        '-    fullName: string;\n+    displayName: string;\n     email: string;\n }',
                    timestamp: Date.now(),
                }];
                const diagnostics = [{
                    range: { start: { line: 11, character: 22 }, end: { line: 11, character: 30 } },
                    severity: 'error' as const,
                    message: "Property 'fullName' does not exist on type 'User'.",
                }];
                const nesClient = new LlamaSweepClient();
                const windowStart = { line: 0, character: 0 };
                const windowLines = windowText.split('\n').length;

                // Контекст из «плагинов» Theia, прогоняемый через чистые источники (как на фронтенде):
                // outline (структура файла), related file (LSP/search), output (отфильтрованный лог).
                const cursorLine0 = windowText.slice(0, cursorOffset).split('\n').length - 1;
                const outline = formatOutline(extractCodeSymbolsHeuristic(windowText), cursorLine0);
                const relatedFiles = [{
                    filePath: 'types.ts',
                    content: 'export interface User {\n    id: string;\n    displayName: string;\n    email: string;\n}',
                }];

                for (const mode of ['no_rag', 'with_rag'] as const) {
                    const neighbors: Neighbor[] = mode === 'with_rag'
                        ? await svc.retrieve(
                            buildSweepRetrievalQuery({ recentEdits, windowText, cursorOffset, diagnostics, maxChars: 400 }),
                            5,
                        )
                        : [];
                    if (mode === 'with_rag') {
                        const found = neighbors.some(n => n.filePath.endsWith('user-service.ts') || n.text.includes('fullName'));
                        record(report, 'NES with_rag: diff-query found cross-file dependency', found,
                            neighbors.map(n => n.filePath).join(','));
                    }
                    const prompt = isSweepModel(NES_MODEL)
                        ? buildSweepPrompt({
                            modelId: NES_MODEL,
                            filePath: 'user-service.ts',
                            windowText,
                            windowStartLine: windowStart.line,
                            originalWindowText: windowText,
                            cursorOffset,
                            recentEdits,
                            diagnostics,
                            neighbors,
                            relatedFiles,
                            outline,
                            editVolume: 'medium',
                            injectInlineDiagnostics: NES_INJECT_DIAG,
                            contextSize: NES_CTX,
                        })
                        : buildNesPrompt({
                            modelId: NES_MODEL,
                            filePath: 'user-service.ts',
                            windowText,
                            windowStartLine: windowStart.line,
                            originalWindowText: windowText,
                            cursorOffset,
                            recentEdits,
                            diagnostics,
                            neighbors,
                            relatedFiles,
                            outline,
                            editVolume: 'medium',
                            injectInlineDiagnostics: NES_INJECT_DIAG,
                            contextSize: NES_CTX,
                        });
                    record(report, `NES ${mode}: prompt not overflow`, !prompt.overflow);
                    if (NES_MODEL === 'sweep-default' || NES_MODEL === 'sweep-small') {
                        const triad = prompt.prompt.split('<|file_sep|>').filter(Boolean).slice(-3);
                        const triadOk =
                            triad.length === 3 &&
                            triad[0].startsWith('original/') &&
                            triad[1].startsWith('current/') &&
                            triad[2].startsWith('updated/');
                        record(report, `NES ${mode}: original/current/updated triad is last`, triadOk,
                            triad.map(t => t.split('\n')[0]).join(' | '));
                        const legacy = LEGACY_NES_SECTIONS.find(s => prompt.prompt.includes(s));
                        record(report, `NES ${mode}: no legacy sweep sections`, !legacy, legacy);

                        const outlineIdx = prompt.prompt.indexOf('<|file_sep|>outline/user-service.ts');
                        const triadIdx = prompt.prompt.indexOf('<|file_sep|>original/user-service.ts');
                        record(report, `NES ${mode}: outline pseudo-file present`, outlineIdx >= 0);
                        record(report, `NES ${mode}: related file block present`, prompt.prompt.includes('<|file_sep|>types.ts\nexport interface User'));
                        record(report, `NES ${mode}: zone B sits before the triad`, outlineIdx >= 0 && triadIdx >= 0 && outlineIdx < triadIdx);
                    }
                    const raw = await nesClient.complete({
                        baseUrl: NES_URL,
                        model: prompt.model,
                        prompt: prompt.prompt,
                        stop: prompt.stop,
                        maxTokens: prompt.maxTokens,
                        temperature: 0.05,
                    });
                    const parsed = isSweepModel(NES_MODEL)
                        ? parseSweepCompletion({ rawText: raw, oldWindowText: windowText, windowStart, stopTokens: prompt.stop, prefill: (prompt as { prefill?: string }).prefill })
                        : parseNesCompletion({ rawText: raw, oldWindowText: windowText, windowStart, stopTokens: prompt.stop });
                    await fs.promises.writeFile(path.join(bundleDir, mode, 'prompts', 'nes.txt'), prompt.prompt);
                    await fs.promises.writeFile(path.join(bundleDir, mode, 'raw_responses', 'nes.txt'), raw);
                    await fs.promises.writeFile(
                        path.join(bundleDir, mode, 'nes_results.json'),
                        JSON.stringify({ modelId: NES_MODEL, neighbors: neighbors.map(n => n.filePath), edits: parsed.edits }, null, 2),
                    );

                    let rangesValid = true;
                    let markerLeak = false;
                    for (const edit of parsed.edits) {
                        if (edit.range.start.line < windowStart.line || edit.range.end.line > windowStart.line + windowLines) {
                            rangesValid = false;
                        }
                        if (NES_MARKER_LEAK.test(edit.newText)) {
                            markerLeak = true;
                        }
                    }
                    record(report, `NES ${mode}: edit ranges inside window`, rangesValid);
                    record(report, `NES ${mode}: no marker leak`, !markerLeak);
                    const combined = parsed.edits.map(e => e.newText).join('');
                    report.quality[`nes_${mode}_edit`] = combined;
                    report.quality[`nes_${mode}_edits_count`] = parsed.edits.length;
                }
            }

            await svc.dispose();
        } finally {
            if (chroma?.pid) {
                try {
                    process.kill(-chroma.pid, 'SIGKILL');
                } catch {
                    try {
                        chroma.kill('SIGKILL');
                    } catch {
                        /* already dead */
                    }
                }
            }
            await fs.promises.rm(storage, { recursive: true, force: true }).catch(() => undefined);
        }

        const passed = report.invariants.filter(i => i.ok).length;
        const failed = report.invariants.filter(i => !i.ok);
        const md = [
            `# Battlefield report ${report.runId}`,
            '',
            `- embedding model: ${report.embedModel} (dim ${report.embedDim})`,
            `- vector db: ${report.vectorDb}`,
            `- FIM model: ${FIM_URL ? FIM_MODEL : 'not run'}`,
            `- NES model: ${NES_URL ? NES_MODEL : 'not run'}`,
            `- files indexed: ${report.filesIndexed} (index ${report.indexMs} ms)`,
            `- invariants passed: ${passed}/${report.invariants.length}`,
            '',
            '## Invariants',
            ...report.invariants.map(i => `- [${i.ok ? 'x' : ' '}] ${i.name}${i.detail ? ` — ${i.detail}` : ''}`),
            '',
            '## Quality notes (model side)',
            '```json',
            JSON.stringify(report.quality, null, 2),
            '```',
        ].join('\n');
        await fs.promises.writeFile(path.join(bundleDir, 'report.md'), md);
        await fs.promises.writeFile(path.join(bundleDir, 'plugin_tests.log'), JSON.stringify(report, null, 2));
        await fs.promises.writeFile(
            path.join(bundleDir, 'endpoints.json'),
            JSON.stringify({ EMBED_URL, EMBED_MODEL, VECTOR_DB, FIM_URL, FIM_MODEL, NES_URL, NES_MODEL }, null, 2),
        );

        console.log(`[battlefield] report written to ${bundleDir}`);
        assert.equal(failed.length, 0, `plugin invariants failed: ${failed.map(f => f.name).join('; ')}`);
    },
);
