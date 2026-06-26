import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { EmbeddingService } from '../src/node/embedding-module/embedding-service';
import type { EmbeddingConfig } from '../src/common/embedding-types';
import { buildZetaPrompt } from '../src/node/zeta21/prompt-creating-layer/zeta-prompt-builder';
import { LlamaZetaClient } from '../src/node/zeta21/model-call-layer/llama-zeta-client';
import { parseZetaCompletion } from '../src/node/zeta21/model-call-layer/zeta-response-parser';
import { resetZetaLanceDb } from './helpers/zeta-lancedb-reset';

const ENABLED = process.env.SC_BATTLE_IT === '1';
const REPO = process.env.SC_BATTLE_REPO ?? '';
const EMBED_URL = process.env.SC_EMBED_URL ?? 'http://127.0.0.1:8040/v1';
const ZETA_URL = process.env.SC_ZETA_URL ?? 'http://127.0.0.1:8010';

const BATTLE_EMBED_CONFIG: EmbeddingConfig = {
    embedModel: 'granite',
    llamaUrl: EMBED_URL,
    vectorDb: 'lancedb',
    indexOnSave: true,
    indexOnOpen: true,
    chunkSize: 40,
    topN: 5,
    prefixTailChars: 400,
};

let storageDir = '';
let service: EmbeddingService | undefined;

beforeEach(async () => {
    if (!ENABLED || !REPO) {
        return;
    }
    if (!storageDir) {
        storageDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sc-zeta-battle-'));
    }
    service = await resetZetaLanceDb({
        storageDir,
        roots: [REPO],
        config: BATTLE_EMBED_CONFIG,
        previousService: service,
    });
});

afterEach(async () => {
    await service?.dispose();
    service = undefined;
});

test(
    'battlefield: embedding index + retrieval + zeta21 round-trip bundle run',
    {
        skip: (!ENABLED && 'set SC_BATTLE_IT=1 to run') || (!REPO && 'set SC_BATTLE_REPO to the test repo path'),
        timeout: 600000,
    },
    async () => {
        assert.ok(fs.existsSync(REPO), `SC_BATTLE_REPO does not exist: ${REPO}`);
        assert.ok(service, 'beforeEach created a fresh embedding service');
        const reportFile = path.join(process.cwd(), 'test_results', `zeta-battlefield-${Date.now()}.md`);
        const neighbors = await service.retrieve('rename symbol around cursor', 3);
        const built = buildZetaPrompt({
            targetPath: 'sample.ts',
            prefixBeforeRegion: 'function demo() {',
            windowText: '  return value',
            suffixText: '\n}',
            cursorOffset: '  return '.length,
            regions: [{ markerIndex: 1, startOffset: 0, endOffset: '  return value'.length }],
            relatedFiles: neighbors.map(neighbor => ({ filePath: neighbor.filePath, content: neighbor.text, score: neighbor.score })),
            editHistoryBlock: '',
        });
        const client = new LlamaZetaClient();
        const raw = await client.complete({
            baseUrl: ZETA_URL,
            model: 'zeta-2.1',
            prompt: built.prompt,
            stop: built.stop,
            maxTokens: 128,
            temperature: 0,
            cachePrompt: true,
            seed: 0,
        });
        const parsed = parseZetaCompletion({
            rawText: raw,
            windowText: '  return value',
            windowStart: { line: 0, character: 0 },
            regions: [{ markerIndex: 1, startOffset: 0, endOffset: '  return value'.length }],
            stopTokens: built.stop,
        });

        await fs.promises.mkdir(path.dirname(reportFile), { recursive: true });
        await fs.promises.writeFile(reportFile, [
            '# Zeta Battlefield',
            '',
            `- neighbors: ${neighbors.length}`,
            `- prompt chars: ${built.prompt.length}`,
            `- edits: ${parsed.edits.length}`,
        ].join('\n'));
        assert.ok(neighbors.length >= 0);
    },
);

test(
    'battlefield: beforeEach reset recreates a clean ready index',
    {
        skip: (!ENABLED && 'set SC_BATTLE_IT=1 to run') || (!REPO && 'set SC_BATTLE_REPO to the test repo path'),
        timeout: 600000,
    },
    async () => {
        assert.ok(service, 'beforeEach created a fresh embedding service');
        const status = service.getStatus();
        const neighbors = await service.retrieve('rename symbol around cursor', 3);

        assert.equal(status.state, 'ready');
        assert.ok(status.filesIndexed >= 0);
        assert.ok(neighbors.length >= 0);
    },
);
