# Smart Completions Plugin Specification

Документ описывает фактическое состояние плагина `smart-completions` на текущий момент. Это не план и не желаемая архитектура, а спецификация реализованного кода.

## 1. Назначение

`smart-completions` — нативное Theia extension для локальных AI-подсказок в редакторе.

Плагин делает:

- Показывает FIM autocomplete как Monaco inline completion / ghost text.
- Показывает NES через Monaco View Zone как preview следующей правки.
- Собирает историю недавних правок пользователя и использует её как обязательный сигнал для NES.
- Индексирует workspace для RAG-контекста.
- Делает retrieval через гибридный поиск: vector search + BM25 + RRF.
- Вызывает локальные `llama.cpp` OpenAI-compatible endpoints для completions и embeddings.
- Поддерживает code/prose режимы: код использует code triggers и tree-sitter chunking, текст использует prose triggers и paragraph/line fallback chunking.
- Предоставляет команды Theia для принятия FIM, принятия/отклонения NES и rebuild индекса.
- Показывает статус embedding-индекса в status bar.

Плагин не делает:

- Не запускает `llama.cpp`, ChromaDB или другие внешние процессы сам.
- Не скачивает модели.
- Не предоставляет отдельную UI-панель настроек; настройки идут через Theia preferences schema.
- Не использует chat completions для FIM/NES; используется raw `/completions`.
- Не стримит ответы модели; `stream: false`.
- Не применяет NES автоматически; пользователь принимает правку явно.
- Не делает глобальный координатор FIM/NES отдельным сервисом; координация встроена в trigger/render логику.
- Не реализует полноценный отдельный Zeta frontend pipeline; `NesBackendServiceImpl` умеет Zeta prompt/parser на backend, но активный frontend NES controller является Sweep controller.
- Не использует одиночный `\n` как серверный FIM stop-token; line-mode обрезается postprocess-логикой.
- Не индексирует бинарные файлы, файлы больше `1_000_000` байт, ignored paths и неподдерживаемые расширения.

## 2. Package And Theia Entry Points

Package metadata:

```json
{
  "name": "smart-completions",
  "description": "Native Theia extension: FIM ghost-text autocomplete + Next Edit Suggestions (local llama.cpp)",
  "theiaExtensions": [
    {
      "frontend": "lib/browser/smart-completions-frontend-module",
      "backend": "lib/node/smart-completions-backend-module"
    }
  ]
}
```

Main dependencies:

- Theia `1.72.3`: core/editor/monaco/preferences/workspace/search/scm/output/markers/hierarchy.
- Monaco editor core `1.108.201`.
- `@lancedb/lancedb` + `apache-arrow` for embedded vector DB.
- `chromadb` for Chroma server integration.
- `ignore` for `.gitignore` handling.
- `web-tree-sitter` + `tree-sitter-wasms` for semantic code chunking.

Build/test scripts:

```json
{
  "build": "tsc -b",
  "test": "tsc -p test/tsconfig.json && node --test lib-test/test/*.test.js"
}
```

## 3. Frontend DI

The frontend module registers preferences, RPC proxies, FIM provider, Sweep/NES controller, embedding sync, status bar and commands.

```ts
export default new ContainerModule(bind => {
    bind(PreferenceContribution).toConstantValue({ schema: SMART_COMPLETIONS_PREFERENCE_SCHEMA });

    bindFimProxy(bind);
    bindNesProxy(bind);
    bindEmbeddingProxy(bind);

    bind(SweepEditHistoryRecorder).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(SweepEditHistoryRecorder);

    bind(FimInlineProvider).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(FimInlineProvider);

    bind(WorkspaceFiles).toSelf().inSingletonScope();
    bind(SymbolSource).toSelf().inSingletonScope();
    bind(OutputSource).toSelf().inSingletonScope();
    bind(SearchRelatedSource).toSelf().inSingletonScope();
    bind(HierarchyRelatedSource).toSelf().inSingletonScope();
    bind(ScmChangedFilesSource).toSelf().inSingletonScope();
    bind(SweepContextCollector).toSelf().inSingletonScope();

    bind(NesViewZoneRenderer).toSelf().inSingletonScope();
    bind(NesController).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(NesController);

    bind(EmbeddingConfigSync).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(EmbeddingConfigSync);

    bind(SmartCompletionsStatusBar).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(SmartCompletionsStatusBar);

    bind(SmartCompletionsCommands).toSelf().inSingletonScope();
    bind(CommandContribution).toService(SmartCompletionsCommands);
    bind(KeybindingContribution).toService(SmartCompletionsCommands);
});
```

## 4. Backend DI And RPC Protocol

Backend exposes three RPC services over Theia websocket messaging:

```ts
export const FIM_SERVICE_PATH = '/services/smart-completions/fim';
export const NES_SERVICE_PATH = '/services/smart-completions/nes';
export const EMBEDDING_SERVICE_PATH = '/services/smart-completions/embedding';

export interface FimBackendService {
    complete(request: FimRequest, token?: CancellationToken): Promise<FimResponse>;
    configure(config: FimConfig): Promise<void>;
}

export interface NesBackendService {
    predict(request: NesRequest, token?: CancellationToken): Promise<NesResponse>;
    configure(config: NesConfig): Promise<void>;
}

export interface EmbeddingIndexService extends RpcServer<EmbeddingIndexClient> {
    rebuild(): Promise<void>;
    reindexFile(uri: string): Promise<void>;
    getStatus(): Promise<IndexStatus>;
    testConnection(target: ConnTarget): Promise<TestResult>;
    configure(config: EmbeddingConfig, workspaceRoots: string[]): Promise<void>;
}
```

Backend bindings:

```ts
export default new ContainerModule(bind => {
    bind(FimBackendServiceImpl).toSelf().inSingletonScope();
    bind(FimBackendService).toService(FimBackendServiceImpl);

    bind(NesBackendServiceImpl).toSelf().inSingletonScope();
    bind(NesBackendService).toService(NesBackendServiceImpl);
    bind(SweepBackendService).toSelf().inSingletonScope();

    bind(EmbeddingIndexServiceImpl).toSelf().inSingletonScope();
    bind(EmbeddingIndexService).toService(EmbeddingIndexServiceImpl);
});
```

## 5. Preferences

Preferences are deterministic and namespaced under `smart-completions.*`.

### Coordination

```ts
'smart-completions.coordinationMode': {
    enum: ['exclusive-priority', 'parallel', 'fim-only', 'nes-only', 'nes-priority'],
    default: 'exclusive-priority',
}
```

Implemented behavior:

- FIM returns no inline completion when mode is `nes-only`.
- NES scheduling/trigger returns early when mode is `fim-only`.
- `exclusive-priority` suppresses NES if the last content change is newer than `nes.debounceMs`.
- `parallel` allows FIM ghost text and NES View Zone to coexist.
- `nes-priority` is accepted by type/schema but has no special branch beyond not being `fim-only` / `nes-only`.

### FIM Preferences

```ts
'smart-completions.fim.enabled': true
'smart-completions.fim.modelId': 'qwen2.5-coder'
'smart-completions.fim.llamaUrl': 'http://127.0.0.1:8010/v1'
'smart-completions.fim.contextSize': 0
'smart-completions.fim.debounceMs': 120
'smart-completions.fim.generationMode': 'multiline'
'smart-completions.fim.temperature': 0.05
'smart-completions.fim.ragEnabled': true
'smart-completions.fim.contextSources.recentEdits': false
'smart-completions.fim.contextSources.repoContext': true
'smart-completions.fim.contextSources.diagnostics': false
```

FIM context max fallback:

```ts
const FIM_CONTEXT_MAX: Record<FimModelId, number> = {
    'qwen2.5-coder': 32768,
    'deepseek-coder': 16384,
    omnicoder: 32768,
    'granite-4.1-8b': 128000,
    'granite-4.1-3b': 128000,
};
```

### NES Preferences

```ts
'smart-completions.nes.enabled': true
'smart-completions.nes.modelId': 'sweep-default'
'smart-completions.nes.llamaUrl': 'http://127.0.0.1:8030/v1'
'smart-completions.nes.contextSize': 16384
'smart-completions.nes.debounceMs': 500
'smart-completions.nes.editVolume': 'medium'
'smart-completions.nes.ragEnabled': true
'smart-completions.nes.injectInlineDiagnostics': false
'smart-completions.nes.relatedTopN': 5
'smart-completions.nes.queryMaxChars': 400
```

### Embedding Preferences

```ts
'smart-completions.embedding.embedModel': 'nomic'
'smart-completions.embedding.llamaUrl': 'http://127.0.0.1:8020/v1'
'smart-completions.embedding.vectorDb': 'lancedb'
'smart-completions.embedding.chromaUrl': 'http://127.0.0.1:8000'
'smart-completions.embedding.indexOnSave': true
'smart-completions.embedding.indexOnOpen': true
'smart-completions.embedding.chunkSize': 40
'smart-completions.embedding.topN': 4
'smart-completions.embedding.prefixTailChars': 400
```

## 6. Models

Model IDs:

```ts
export type FimModelId =
    | 'qwen2.5-coder'
    | 'deepseek-coder'
    | 'omnicoder'
    | 'granite-4.1-8b'
    | 'granite-4.1-3b';

export type NesModelId = 'sweep-default' | 'sweep-small' | 'zeta' | 'zeta-2.1';
export type EmbedModelId = string;
export type VectorDbId = 'lancedb' | 'chromadb';
```

FIM model specs:

```ts
const SPECS: Record<FimModelId, FimModelSpec> = {
    'qwen2.5-coder': {
        templateId: 'qwen',
        llamaModel: 'qwen2.5-coder',
        supportsRepoContext: true,
        tokens: QWEN_TOKENS,
        repoNameToken: '<|repo_name|>',
        fileToken: '<|file_sep|>',
    },
    omnicoder: {
        templateId: 'qwen',
        llamaModel: 'omnicoder',
        supportsRepoContext: true,
        tokens: QWEN_TOKENS,
        repoNameToken: '<|repo_name|>',
        fileToken: '<|file_sep|>',
    },
    'deepseek-coder': {
        templateId: 'deepseek',
        llamaModel: 'deepseek-coder',
        supportsRepoContext: false,
        tokens: DEEPSEEK_TOKENS,
    },
    'granite-4.1-8b': {
        templateId: 'granite',
        llamaModel: 'granite-4.1-8b',
        supportsRepoContext: true,
        tokens: GRANITE_TOKENS,
        repoNameToken: '<|reponame|>',
        fileToken: '<|filename|>',
    },
    'granite-4.1-3b': {
        templateId: 'granite',
        llamaModel: 'granite-4.1-3b',
        supportsRepoContext: true,
        tokens: GRANITE_TOKENS,
        repoNameToken: '<|reponame|>',
        fileToken: '<|filename|>',
    },
};
```

NES backend routing:

```ts
function isSweepModelId(modelId: string): modelId is 'sweep-default' | 'sweep-small' {
    return modelId === 'sweep-default' || modelId === 'sweep-small';
}
```

Sweep llama model mapping:

```ts
function llamaModelForSweep(modelId: string): string {
    return modelId === 'sweep-small' ? 'sweep-next-edit-small' : 'sweep-next-edit-v2';
}
```

Embedding model aliases:

```ts
const EMBED_MODEL_ALIAS: Record<string, string> = {
    nomic: 'nomic-embed-text',
    granite: 'granite-embedding',
};
```

Unknown embedding model names pass through as-is.

## 7. FIM Pipeline

FIM pipeline is:

```text
trigger layer -> data gathering layer -> prompt formatting layer -> model call layer -> render layer
```

In the implementation, trigger, editor data gathering and render are inside `FimInlineProvider`; backend context formation and model call are inside `FimBackendServiceImpl`.

### 7.1 Trigger Layer

FIM registers a Monaco inline completions provider for `file` and `untitled` schemes.

```ts
this.toDispose.push(monaco.languages.registerInlineCompletionsProvider([{ scheme: 'file' }, { scheme: 'untitled' }], this));
```

Automatic trigger gating:

```ts
function shouldTrigger(model: monaco.editor.ITextModel, position: monaco.Position, fileMode: 'code' | 'prose'): boolean {
    if (position.column < model.getLineMaxColumn(position.lineNumber)) {
        const next = model.getLineContent(position.lineNumber).charAt(position.column - 1);
        if (/\w/.test(next)) {
            return false;
        }
    }
    const previous = previousCharacter(model, position);
    if (!previous) {
        return false;
    }
    if (fileMode === 'code') {
        return /[ \t\n{:.]/.test(previous);
    }
    return /[ \n.!?]/.test(previous);
}
```

FIM is skipped when disabled or when coordination mode is `nes-only`.

### 7.2 Data Gathering Layer

FIM gathers from the active Monaco model:

- `uri`
- `languageId`
- `fileMode`
- prefix before cursor
- suffix after cursor
- generation mode

```ts
const response = await this.fim.complete({
    requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    uri: model.uri.toString(),
    languageId: model.getLanguageId(),
    fileMode,
    prefix: model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
    }),
    suffix: model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: model.getLineCount(),
        endColumn: model.getLineMaxColumn(model.getLineCount()),
    }),
    generationMode: this.config.generationMode,
}, source.token);
```

Backend optionally gathers RAG neighbors when the model supports repo context and FIM RAG is enabled:

```ts
const neighbors = spec.supportsRepoContext && this.config.ragEnabled && this.config.contextSources.repoContext
    ? await this.retrieveNeighbors(prefix, abort.signal)
    : [];
```

FIM retrieval query is the prefix tail:

```ts
const options = this.embedding.getRetrievalOptions();
const query = prefix.slice(-options.prefixTailChars);
return this.embedding.retrieve(query, options.topN, signal);
```

### 7.3 Prompt Formatting Layer

FIM normalizes CRLF to LF, semantically trims prefix/suffix and renders native FIM tokens.

```ts
const fim = `${spec.tokens.prefix}${trimmed.prefix}${spec.tokens.suffix}${trimmed.suffix}${spec.tokens.middle}`;
```

Repo-aware FIM prompt is used only when actual neighbors exist:

```ts
return {
    prompt: useRepoContext
        ? renderRepoPrompt(spec.repoNameToken!, spec.fileToken!, input.repoName, input.filePath, normalizedNeighbors, fim)
        : fim,
    stop: fimStopTokens(spec),
    maxTokens: fimMaxTokens(input.generationMode),
    llamaModel: spec.llamaModel,
};
```

Repo prompt format:

```ts
function renderRepoPrompt(repoNameToken: string, fileToken: string, repoName = 'workspace', filePath = 'current-file', neighbors: Neighbor[], currentFim: string): string {
    const chunks = [`${repoNameToken}${repoName}`];
    for (const neighbor of neighbors) {
        chunks.push(`${fileToken}${neighbor.filePath}\n${neighbor.text}`);
    }
    chunks.push(`${fileToken}${filePath}\n${currentFim}`);
    return chunks.join('\n');
}
```

FIM stop tokens are model tokens plus extra model-specific stops. A raw single newline is intentionally not used as server-side stop in current code.

```ts
export function fimStopTokens(spec: FimModelSpec): string[] {
    const stops = [spec.tokens.prefix, spec.tokens.suffix, spec.tokens.middle, ...spec.tokens.extraStops];
    return Array.from(new Set(stops));
}
```

FIM max token policy:

```ts
export function fimMaxTokens(generationMode: GenerationMode): number {
    switch (generationMode) {
        case 'line':
            return 48;
        case 'block':
            return 384;
        default:
            return 160;
    }
}
```

### 7.4 Model Call Layer

FIM calls `POST {llamaUrl}/completions` with raw prompt and no streaming.

```ts
const body = {
    model: request.model,
    prompt: request.prompt,
    max_tokens: request.maxTokens,
    temperature: request.temperature,
    stop: request.stop,
    stream: false,
};
```

It retries one time on HTTP 503 using `Retry-After` or 200 ms default:

```ts
if (response.status === 503 && retry503) {
    await wait(retryAfterMs(response), signal);
    return this.post(baseUrl, body, signal, false);
}
```

Cancellation is bridged from Theia `CancellationToken` to `AbortSignal`.

### 7.5 Render Layer

FIM render uses Monaco inline completion items:

```ts
return {
    items: [{
        insertText: response.text,
        range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
    }],
    suppressSuggestions: false,
};
```

Accept command runs Monaco inline suggest commit:

```ts
registry.registerCommand(FimAcceptCommand, {
    execute: async () => this.monacoEditors.current?.runAction('editor.action.inlineSuggest.commit'),
});
```

Default keybinding:

```ts
{ command: FimAcceptCommand.id, keybinding: 'tab', when: 'inlineSuggestionVisible && !editorReadonly' }
```

## 8. NES / Sweep Pipeline

NES pipeline is:

```text
trigger layer -> data gathering layer -> prompt formatting layer -> model call layer -> render layer
```

Active frontend NES controller is a re-export of Sweep controller:

```ts
export { SweepController as NesController } from '../sweep/trigger-layer/sweep-controller';
```

Active NES renderer is a View Zone renderer:

```ts
export { NesViewZoneRenderer } from '../nes-render/nes-view-zone-renderer';
```

### 8.1 Trigger Layer

Sweep controller tracks all existing and future Monaco editors.

```ts
for (const editor of monaco.editor.getEditors()) {
    this.trackEditor(editor);
}
this.toDispose.push(monaco.editor.onDidCreateEditor(editor => this.trackEditor(editor)));
```

It schedules predictions on content changes and cursor moves:

```ts
disposable.push(editor.onDidChangeModelContent(() => {
    this.lastChangeAt = Date.now();
    this.renderer.dismiss();
    this.schedule(editor);
}));
disposable.push(editor.onDidChangeCursorPosition(() => this.schedule(editor)));
```

Debounce and coordination:

```ts
private schedule(editor: monaco.editor.ICodeEditor): void {
    if (!this.enabled || this.coordinationMode === 'fim-only') {
        return;
    }
    if (this.timer) {
        clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.trigger(editor), this.config.debounceMs);
}
```

`exclusive-priority` timing gate:

```ts
if (this.coordinationMode === 'exclusive-priority' && Date.now() - this.lastChangeAt < this.config.debounceMs) {
    return;
}
```

In-flight requests are cancelled before a new request starts:

```ts
this.inFlight?.cancel();
this.inFlight?.dispose();
const source = new CancellationTokenSource();
this.inFlight = source;
```

Model version is captured and checked before rendering:

```ts
const version = model.getVersionId();
if (source.token.isCancellationRequested || model.getVersionId() !== version) {
    return;
}
```

### 8.2 Data Gathering Layer

NES requires recent edit history. If history is empty, prediction stops before expensive context collection.

```ts
const recentEdits = history.getRecentEdits(uri, 8);
if (recentEdits.length === 0) {
    return undefined;
}
```

Edit history recorder listens to Monaco model changes and delegates diff/debounce to `EditHistoryStore`.

```ts
this.store.track({ uri, getValue: () => model.getValue() });
disposable.push(model.onDidChangeContent(() => this.store.scheduleRecord(uri)));
```

Sweep snapshot includes:

- 40-line editor window: 20 lines before cursor and 20 lines after cursor.
- Window start position.
- Cursor offset inside the window.
- Original window text before last edit when available.
- Recent edits.
- Monaco diagnostics.

```ts
const startLineNumber = Math.max(1, position.lineNumber - 20);
const endLineNumber = Math.min(model.getLineCount(), position.lineNumber + 20);
const text = model.getValueInRange(range);
const cursorOffset = model.getOffsetAt(position) - model.getOffsetAt({ lineNumber: startLineNumber, column: 1 });
```

Context collector sources:

- `SymbolSource`: current file outline.
- `OutputSource`: Theia output snippets.
- `SearchRelatedSource`: search-in-workspace related files.
- `HierarchyRelatedSource`: call/type hierarchy related files.
- `ScmChangedFilesSource`: dirty SCM files.
- `WorkspaceFiles`: relative paths and file windows.

Collection is best-effort; source failures are logged and replaced by fallback values.

```ts
private async safeAsync<T>(fn: () => Promise<T>, fallback: T, label: string): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        LOG.warn('Sweep async context source failed', { label, error: error instanceof Error ? error.message : String(error) });
        return fallback;
    }
}
```

Related file queries are built from recent edits, cursor window and diagnostics. Candidates from hierarchy/search/SCM are deduped and ranked.

```ts
const queries = buildRelatedFileQueries({
    recentEdits: params.recentEdits,
    windowText: params.windowText,
    cursorOffset: params.cursorOffset,
    diagnostics: params.diagnostics,
    maxChars: params.queryMaxChars,
});

const relatedFiles = dedupeRankRelated(relatedCandidates, params.relatedTopN);
```

Output snippets are skipped when diagnostics contain errors:

```ts
const outputSnippets = hasErrors ? [] : this.safe(() => this.outputSource.collect(), [] as SweepOutputSnippet[], 'output');
```

### 8.3 Prompt Formatting Layer

Sweep backend performs RAG retrieval before prompt creation when enabled:

```ts
const neighbors = this.config.ragEnabled ? await this.retrieveNeighbors(request, windowText, abort.signal) : [];
```

Sweep retrieval query uses edit signal, not blind full-file context:

```ts
const query = buildSweepRetrievalQuery({
    recentEdits: request.recentEdits,
    windowText,
    cursorOffset: request.cursorOffset,
    diagnostics: request.diagnostics,
    maxChars: this.config.queryMaxChars || options.prefixTailChars,
});
```

Prompt building input:

```ts
const prompt = buildSweepPrompt({
    modelId: this.config.modelId,
    filePath: this.filePathForUri(request.uri),
    windowText,
    windowStartLine: request.windowStart.line,
    originalWindowText: request.originalWindowText,
    cursorOffset: request.cursorOffset,
    recentEdits: this.recentEditsForPrompt(request.recentEdits),
    diagnostics: request.diagnostics,
    neighbors,
    relatedFiles: request.relatedFiles,
    outline: request.outline,
    outputSnippets: request.outputSnippets,
    editVolume: this.config.editVolume,
    injectInlineDiagnostics: this.config.injectInlineDiagnostics,
    contextSize: this.config.contextSize,
});
```

Sweep prompt sections are ordered in training format:

```ts
function buildSweepSections(input: BuildSweepPromptInput, trimmed: TrimmedSweepContext, range: string): string[] {
    const sections: string[] = [];

    sections.push(...formatSweepNeighborFileBlocks(trimmed.neighbors));
    sections.push(...formatSweepRelatedFileBlocks(trimmed.relatedFiles));

    if (trimmed.outline) {
        sections.push(`<|file_sep|>outline/${input.filePath}\n${trimmed.outline}`);
    }
    if (trimmed.diagnostics.length > 0) {
        sections.push(`<|file_sep|>diagnostics/${input.filePath}\n${formatSweepDiagnosticsLines(trimmed.diagnostics)}`);
    }
    for (const snippet of trimmed.outputSnippets) {
        sections.push(`<|file_sep|>output/${snippet.channel}\n${normalizeCrlf(snippet.text)}`);
    }

    sections.push(...formatSweepDiffBlocks(trimmed.recentEdits));

    const currentWindow = insertCursor(trimmed.windowText, trimmed.cursorOffset, '<|cursor|>');
    sections.push(`<|file_sep|>original/${input.filePath}:${range}\n${trimmed.originalWindowText}`);
    sections.push(`<|file_sep|>current/${input.filePath}:${range}\n${currentWindow}`);
    sections.push(`<|file_sep|>updated/${input.filePath}:${range}\n${trimmed.prefill}`);

    return sections;
}
```

Sweep stop/max token policy:

```ts
return {
    prompt,
    stop: ['<|file_sep|>', '<|endoftext|>'],
    maxTokens,
    model: llamaModel,
    format: 'sweep',
    overflow: trimmed.overflow,
    prefill: trimmed.prefill,
};
```

Edit volume mapping:

```ts
function maxTokensForSweepVolume(volume: SweepEditVolume): number {
    switch (volume) {
        case 'small':
            return 128;
        case 'large':
            return 512;
        default:
            return 256;
    }
}
```

Prompt overflow returns no edit:

```ts
if (prompt.overflow) {
    return { edits: [], modelId: this.config.modelId };
}
```

### 8.4 Sweep Next Edit Prompt Slots

Current Sweep Next Edit prompt is a raw completion prompt in Sweep training format. It is not a classic FIM prompt with `<|fim_prefix|>`, `<|fim_suffix|>`, `<|fim_middle|>` tokens. The effective Sweep slots are file-like blocks separated by `<|file_sep|>`. The model generates the continuation of the final `updated/...` block.

Special tokens used by Sweep:

```text
<|file_sep|>  separates context/task blocks and is also a stop token
<|cursor|>    marks the user cursor inside the current/ block
<|endoftext|> stop token
```

Sweep stop tokens:

```ts
stop: ['<|file_sep|>', '<|endoftext|>']
```

Prompt block order is fixed and must not be reordered:

```text
1. RAG neighbor file blocks
2. Related file blocks from Theia/LSP/search/SCM
3. outline pseudo-file
4. diagnostics pseudo-file
5. output pseudo-files
6. recent edit diff blocks
7. original/current/updated task triad
```

Slot mapping:

```text
<|file_sep|>{neighbor.filePath}
{neighbor.text}
```

Data: chunks returned by embedding RAG. Each chunk has `filePath`, `startLine`, `endLine`, `language`, `nodeType`, `text`, `score`. Only `filePath` and normalized `text` are rendered into the prompt.

```text
<|file_sep|>{related.filePath}
{related.content}
```

Data: related files gathered on the frontend from search-in-workspace, call/type hierarchy and SCM changed files. These are best-effort context files ranked and deduplicated before prompt creation.

```text
<|file_sep|>outline/{currentFilePath}
{outline}
```

Data: compact outline of the current file from `SymbolSource`, formatted as a pseudo-file. This block is omitted when no outline is available or when context trimming drops it.

```text
<|file_sep|>diagnostics/{currentFilePath}
Line {line}: {message}
```

Data: Monaco diagnostics from the current model. Errors are higher priority than warnings. In current Sweep prompt builder diagnostics are rendered when retained by trimming. The preference `smart-completions.nes.injectInlineDiagnostics` is passed into prompt creation; current Sweep-specific builder renders retained diagnostics as a pseudo-file.

```text
<|file_sep|>output/{channel}
{snippet.text}
```

Data: Theia Output channel snippets. Output snippets are skipped entirely when current diagnostics include errors, because diagnostics are a stronger signal and output logs add noise.

```text
<|file_sep|>{edit.uri}.diff
original:
{original text reconstructed from unified diff}
updated:
{updated text reconstructed from unified diff}
```

Data: mandatory recent edit history. NES does not run without recent edits. The recorder stores unified diffs; prompt formatting converts each diff into `original:` and `updated:` sections. Paths are normalized to workspace-relative paths before rendering.

Task triad:

```text
<|file_sep|>original/{currentFilePath}:{startLine}:{endLine}
{originalWindowText}

<|file_sep|>current/{currentFilePath}:{startLine}:{endLine}
{windowTextBeforeCursor}<|cursor|>{windowTextAfterCursor}

<|file_sep|>updated/{currentFilePath}:{startLine}:{endLine}
{prefill}
```

Data:

- `original/...`: editor window before the last edit when available; otherwise the current window.
- `current/...`: current editor window around cursor, with `<|cursor|>` inserted at `cursorOffset`.
- `updated/...`: final generation slot. Current default `prefill` is empty, so the model must generate the updated window continuation from this point.

The exact implementation that assembles these slots:

```ts
sections.push(...formatSweepNeighborFileBlocks(trimmed.neighbors));
sections.push(...formatSweepRelatedFileBlocks(trimmed.relatedFiles));

if (trimmed.outline) {
    sections.push(`<|file_sep|>outline/${input.filePath}\n${trimmed.outline}`);
}
if (trimmed.diagnostics.length > 0) {
    sections.push(`<|file_sep|>diagnostics/${input.filePath}\n${formatSweepDiagnosticsLines(trimmed.diagnostics)}`);
}
for (const snippet of trimmed.outputSnippets) {
    sections.push(`<|file_sep|>output/${snippet.channel}\n${normalizeCrlf(snippet.text)}`);
}

sections.push(...formatSweepDiffBlocks(trimmed.recentEdits));

const currentWindow = insertCursor(trimmed.windowText, trimmed.cursorOffset, '<|cursor|>');
sections.push(`<|file_sep|>original/${input.filePath}:${range}\n${trimmed.originalWindowText}`);
sections.push(`<|file_sep|>current/${input.filePath}:${range}\n${currentWindow}`);
sections.push(`<|file_sep|>updated/${input.filePath}:${range}\n${trimmed.prefill}`);
```

Context trimming priority for Sweep slots:

```text
kept first: original/current/updated task window
then: error diagnostics
then: recent edits
then: RAG neighbors and related files
then: warning diagnostics
then: outline
then: output snippets
```

If the mandatory task window does not fit into the configured context budget, `overflow` is set and no NES suggestion is requested from the model.

### 8.5 Zeta Backend Capability

`NesBackendServiceImpl` supports Zeta/Zeta 2.1 prompt creation when `modelId` is not Sweep. This is backend-capable, but current frontend controller remains Sweep-based.

Zeta 2.1 prompt shape:

```ts
const prefixStream = `<[fim-prefix]>${prefixSections.join('\n\n')}`;
const prompt = ['<[fim-suffix]>', prefixStream, '<[fim-middle]>'].join('\n');
return {
    prompt,
    stop: ['<|marker_2|>', '<[fim-suffix]>', '<|endoftext|>', '<|end_of_text|>'],
    maxTokens,
    model: 'zeta',
    format: 'zeta-2.1',
    overflow: trimmed.overflow,
};
```

### 8.6 Model Call Layer

Sweep calls raw `POST {llamaUrl}/completions`.

```ts
const body = {
    model: request.model,
    prompt: request.prompt,
    max_tokens: request.maxTokens,
    temperature: request.temperature,
    stop: request.stop,
    stream: false,
};
```

Temperature is fixed to `0.05` for Sweep/NES backend calls.

```ts
const rawText = await this.client.complete({
    baseUrl: this.config.llamaUrl,
    model: prompt.model,
    prompt: prompt.prompt,
    stop: prompt.stop,
    maxTokens: prompt.maxTokens,
    temperature: 0.05,
    signal: abort.signal,
});
```

One retry on 503 is implemented:

```ts
if (response.status === 503 && retry503) {
    const retryMs = retryAfterMs(response);
    await wait(retryMs, signal);
    return this.post(baseUrl, bodyText, signal, false);
}
```

### 8.7 Response Parser Layer

Sweep response parser:

- Normalizes CRLF.
- Removes Sweep markers and stop tokens.
- Combines `prefill + raw completion` into updated window.
- Treats empty output and `NO_EDITS` as no-op.
- Computes minimal line-based replacement by common prefix/suffix.

```ts
export function parseSweepCompletion(input: ParseSweepCompletionInput): ParsedSweepCompletion {
    const cleaned = cleanSweepResponse(input.rawText, input.stopTokens);
    const prefill = input.prefill ? normalizeCrlf(input.prefill) : '';
    const updatedWindow = prefill ? prefill + cleaned : cleaned;
    if (!updatedWindow || updatedWindow.trim() === 'NO_EDITS') {
        return { edits: [] };
    }
    const edit = diffWindows(normalizeCrlf(input.oldWindowText), updatedWindow, input.windowStart);
    if (!edit) {
        return { edits: [] };
    }
    return {
        edits: [edit],
        primaryRange: edit.range,
        jumpTo: edit.range.start,
    };
}
```

Marker cleanup:

```ts
function cleanSweepResponse(rawText: string, stopTokens: string[]): string {
    let text = normalizeCrlf(rawText).replace(SWEEP_MARKERS, '').trimEnd();
    for (const stop of stopTokens) {
        const index = text.indexOf(stop);
        if (index >= 0) {
            text = text.slice(0, index).trimEnd();
        }
    }
    return text;
}
```

### 8.8 Render Layer

NES renders only as View Zone in current active frontend.

Show:

```ts
show(editor: monaco.editor.ICodeEditor, response: NesResponse): void {
    this.dismiss();
    if (response.edits.length === 0) {
        return;
    }
    this.editor = editor;
    this.response = response;
    const node = this.createNode(response);
    const afterLineNumber = Math.max(0, (response.primaryRange?.start.line ?? 0) + 1);
    editor.changeViewZones(accessor => {
        this.zoneId = accessor.addZone({
            afterLineNumber,
            heightInLines: Math.min(12, Math.max(3, lineCount(response.edits[0].newText) + 2)),
            domNode: node,
            suppressMouseDown: true,
        });
    });
}
```

Accept:

```ts
accept(): void {
    const editor = this.editor;
    const response = this.response;
    if (!editor || !response || response.edits.length === 0) {
        return;
    }
    editor.executeEdits('smart-completions-nes', response.edits.map(toMonacoEdit));
    if (response.jumpTo) {
        editor.setPosition(toMonacoPosition(response.jumpTo));
        editor.revealPositionInCenterIfOutsideViewport(toMonacoPosition(response.jumpTo));
    }
    this.dismiss();
}
```

Jump or accept:

```ts
if (current && current.lineNumber === target.lineNumber && current.column === target.column) {
    this.accept();
    return;
}
editor.setPosition(target);
editor.revealPositionInCenterIfOutsideViewport(target);
```

Default keybindings:

```ts
{ command: NesJumpOrAcceptCommand.id, keybinding: 'alt+tab', when: '!editorReadonly' }
{ command: NesDismissCommand.id, keybinding: 'esc', when: '!editorReadonly' }
```

## 9. Embedding / RAG Pipeline

Embedding pipeline is:

```text
preference/workspace sync -> indexer -> chunker -> embed client -> vector store + BM25 -> retriever -> FIM/NES context
```

### 9.1 Frontend Sync

Embedding config and workspace roots are pushed from frontend to backend on startup, preference changes and workspace changes.

```ts
private async push(): Promise<void> {
    const config = readEmbeddingConfig(this.preferences);
    const roots = this.workspace.tryGetRoots().map(stat => stat.resource.toString());
    await this.indexService.configure(config, roots);
}
```

Incremental reindex is triggered on file changes when `indexOnSave` is enabled.

```ts
for (const change of event.changes) {
    void this.indexService.reindexFile(change.resource.toString()).catch(() => undefined);
}
```

### 9.2 Backend Service

Embedding index storage root defaults to:

```ts
path.join(os.homedir(), '.theia', 'smart-completions', 'embedding')
```

Workspace-specific storage uses `md5(roots.join('|') || 'default')`.

```ts
const workspaceDir = path.join(this.deps.storageDir, md5(roots.join('|') || 'default'));
```

Backend retrieval is not exposed over RPC; FIM/NES backend services call `EmbeddingIndexServiceImpl.retrieve()` directly.

```ts
async retrieve(queryText: string, topN: number, signal?: AbortSignal): Promise<Neighbor[]> {
    return this.service.retrieve(queryText, topN, signal);
}
```

### 9.3 Indexing

Indexing performs:

- `.gitignore` loading.
- Skip-dir filtering.
- Extension filtering.
- Max file size check.
- CRLF normalization.
- Code/prose chunking.
- Batched embeddings with batch size `32`.
- Idempotent upsert into vector store.
- BM25 indexing.
- Persistent file metadata for reconcile.

Skip dirs:

```ts
export const SKIP_DIRS = [
    '.git',
    'node_modules',
    '.venv',
    'venv',
    '__pycache__',
    '.next',
    '.nuxt',
    '.cache',
    '.gradle',
    '.turbo',
    '.parcel-cache',
    'dist',
    'build',
    'target',
    'coverage',
    'out',
    'vendor',
];
```

Max file bytes:

```ts
export const MAX_FILE_BYTES = 1_000_000;
```

Index file core:

```ts
const languageId = languageIdForExtension(path.extname(rel));
const chunks = await this.services.chunker.chunk(rel, content, languageId);

await this.removeFileChunks(rel);
if (chunks.length > 0) {
    const vectors = await this.embedAll(chunks.map(c => c.text), signal);
    const records: ChunkRecord[] = chunks.map((c, i) => ({
        id: chunkId(c.filePath, c.startLine, c.endLine),
        filePath: c.filePath,
        startLine: c.startLine,
        endLine: c.endLine,
        language: c.language,
        nodeType: c.nodeType,
        text: c.text,
        vector: vectors[i] ?? [],
    }));
    await this.services.store.upsert(records);
    this.services.bm25.add(records);
}
```

### 9.4 Chunking

Chunking dispatcher:

```ts
export class Chunker {
    private readonly codeChunker = new TreeSitterChunker();

    async chunk(filePath: string, source: string, languageId: string): Promise<Chunk[]> {
        if (isCodeLanguage(languageId)) {
            const codeChunks = await this.codeChunker.chunk(filePath, source, languageId);
            if (codeChunks.length > 0) {
                return codeChunks;
            }
        }
        return chunkProse(filePath, source, languageId);
    }
}
```

Code chunking uses greedy top-level named tree-sitter nodes:

```ts
for (const node of tree.rootNode.namedChildren) {
    const text = node.text;
    if (text.trim().length < MIN_CHARS) {
        continue;
    }
    chunks.push({
        filePath,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        language: languageId,
        nodeType: node.type,
        text,
    });
}
```

Prose chunking uses paragraphs, with large paragraphs split by line windows:

```ts
export function chunkProse(filePath: string, source: string, languageId: string, windowLines = 40): Chunk[] {
    const lines = source.split('\n');
    // paragraphs separated by empty lines; long paragraphs split by windowLines
}
```

### 9.5 Embedding Client

Embeddings use OpenAI-compatible `POST {llamaUrl}/embeddings`.

```ts
const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: this.options.model, input: inputs }),
    signal,
});
```

### 9.6 Vector Stores

Configured store:

```ts
function defaultCreateStore(config: EmbeddingConfig, storageDir: string): VectorStore {
    if (config.vectorDb === 'chromadb') {
        return new ChromaVectorStore(config.chromaUrl ?? 'http://127.0.0.1:8000');
    }
    return new LanceVectorStore(path.join(storageDir, 'lancedb'));
}
```

LanceDB is embedded file storage. ChromaDB requires an external Chroma server.

### 9.7 Retrieval

Hybrid retrieval uses vector search and BM25, then merges with RRF.

```ts
export function reciprocalRankFusion(lists: VectorHit[][], topN: number, k = RRF_K): VectorHit[] {
    const score = new Map<string, number>();
    const best = new Map<string, VectorHit>();
    for (let i = 0; i < lists.length; i++) {
        const list = lists[i];
        for (let rank = 0; rank < list.length; rank++) {
            const hit = list[rank];
            const id = hit.record.id;
            score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1));
            if (!best.has(id)) {
                best.set(id, hit);
            }
        }
    }
    const ranked = Array.from(score.entries()).sort((a, b) => b[1] - a[1]);
    return ranked.slice(0, topN).map(([id, s]) => ({ record: best.get(id)!.record, score: s }));
}
```

Runtime retriever:

```ts
const fetchN = topN * 2;
let vectorHits: VectorHit[] = [];
try {
    const vectors = await this.embed.embed([queryText], signal);
    if (vectors[0] && !signal?.aborted) {
        vectorHits = await this.store.vectorSearch(vectors[0], fetchN);
    }
} catch {
    // degrade to lexical search
}

const lexicalHits = this.bm25.search(queryText, fetchN);
const merged = reciprocalRankFusion([vectorHits, lexicalHits], topN);
```

If embedding/vector search fails, retrieval degrades to BM25 instead of failing completion.

## 10. Code / Prose Modes

Frontend file mode is determined by Monaco language ID.

```ts
export function fileModeForLanguage(languageId: string): FileMode {
    return CODE_LANGUAGES.has(languageId.toLowerCase()) ? 'code' : 'prose';
}
```

FIM trigger behavior:

- Code: trigger after space, tab, newline, `{`, `:`, `.`.
- Prose: trigger after space, newline, `.`, `!`, `?`.
- Both modes avoid triggering inside a word.

Embedding chunking behavior:

- Code: tree-sitter top-level chunks when grammar exists.
- Prose: paragraph/line fallback.

NES behavior:

- Uses same request path for code and prose.
- Models are code-oriented; prose support is structural fallback, not quality guarantee.

## 11. Commands And Keybindings

Commands:

```ts
smart-completions.rebuildIndex
smart-completions.testConnection
smart-completions.fim.accept
smart-completions.nes.accept
smart-completions.nes.dismiss
smart-completions.nes.jumpOrAccept
```

Keybindings:

```ts
tab      -> smart-completions.fim.accept when inlineSuggestionVisible && !editorReadonly
alt+tab  -> smart-completions.nes.jumpOrAccept when !editorReadonly
esc      -> smart-completions.nes.dismiss when !editorReadonly
```

`testConnection` only tests the embedding connection target through the current embedding client path.

## 12. Status Bar

Status bar item ID:

```ts
const ITEM_ID = 'smart-completions-index';
```

Rendered states:

```ts
indexing -> '$(sync~spin) SC index {filesIndexed}/{totalFiles}'
ready    -> '$(database) SC index ready'
error    -> '$(error) SC index error'
idle     -> '$(database) SC index idle'
```

## 13. Cancellation, Retry, Normalization

Cancellation:

- Frontend creates Theia `CancellationTokenSource` per request.
- Backend bridges Theia token to `AbortController`.
- Fetch calls receive `AbortSignal`.
- NES checks Monaco model version before render.

Retry:

- FIM and NES completion clients retry once on HTTP 503.
- Default retry delay is 200 ms unless `Retry-After` is provided.

Normalization:

- FIM/NES request text is normalized from CRLF to LF before prompt creation.
- Embedding indexing normalizes file content to LF before chunking.

## 14. Deterministic Runtime Flow

### FIM

```text
1. Theia starts frontend module.
2. FimInlineProvider registers Monaco inline completions provider.
3. Preferences are read and pushed to FimBackendServiceImpl.
4. User types or explicitly triggers inline completion.
5. Provider checks enabled, coordination mode and trigger character.
6. Provider sends prefix/suffix/file metadata over RPC.
7. Backend normalizes CRLF, optionally retrieves RAG neighbors.
8. Backend builds native FIM prompt for selected model.
9. Backend calls llama.cpp /completions.
10. Backend postprocesses model text.
11. Frontend returns Monaco inline completion item.
12. User accepts with Tab / Monaco inline suggest commit.
```

### Sweep NES

```text
1. Theia starts frontend module.
2. SweepEditHistoryRecorder starts tracking Monaco models.
3. SweepController tracks editors and preferences.
4. User edits document; edit history is recorded after store debounce.
5. Controller dismisses old suggestion and schedules debounce.
6. Trigger verifies enabled state, coordination mode and model version.
7. RequestBuilder snapshots editor window, diagnostics and recent edits.
8. If recent edits are empty, NES stops.
9. SweepContextCollector gathers outline, related files, SCM files and output snippets.
10. RequestBuilder builds SweepRequest.
11. NesBackendServiceImpl routes Sweep IDs to SweepBackendService.
12. Backend normalizes text and optionally performs RAG retrieval.
13. Backend builds Sweep training-format prompt.
14. Backend calls llama.cpp /completions.
15. Backend parses updated window into one minimal TextEditDTO.
16. Controller verifies cancellation/version and renders View Zone.
17. User presses Alt+Tab to jump/accept, or Esc to dismiss.
```

### Embedding / RAG

```text
1. EmbeddingConfigSync reads preferences and workspace roots.
2. Backend EmbeddingIndexServiceImpl configures EmbeddingService.
3. If indexOnOpen is true, service starts reconcile in background.
4. RepoIndexer walks workspace with skip dirs, .gitignore and extension filters.
5. Files are normalized and chunked as code or prose.
6. Chunks are embedded via llama.cpp /embeddings in batches.
7. Chunks are upserted into LanceDB/ChromaDB and BM25.
8. On save/change, changed file is reindexed if indexOnSave is true.
9. FIM/NES backend asks retrieve(query, topN).
10. HybridRetriever runs vector search and BM25, merges by RRF.
11. Retrieved chunks are inserted into model-specific prompt slots.
```

## 15. Source File Map

Common:

- `src/common/protocol.ts`: RPC service contracts and paths.
- `src/common/model-types.ts`: model IDs and coordination modes.
- `src/common/fim-types.ts`: FIM request/config/response types.
- `src/common/nes-types.ts`: NES request/config/response types.
- `src/common/embedding-types.ts`: embedding/index/retrieval types.
- `src/common/edit-history-types.ts`: recent edit types.
- `src/common/editor-dto.ts`: editor DTOs.
- `src/common/mode-types.ts`: code/prose mode type.
- `src/common/text/crlf.ts`: CRLF normalization helpers.
- `src/common/sweep/*`: Sweep logger, related-file ranking, outline, signals, retrieval query and edit-history store.
- `src/common/nes-context/*`: older/general NES context helpers.

Frontend:

- `src/browser/smart-completions-frontend-module.ts`: frontend DI.
- `src/browser/preferences/preferences-schema.ts`: preferences and config readers.
- `src/browser/proxies.ts`: RPC proxy bindings.
- `src/browser/commands.ts`: commands and keybindings.
- `src/browser/shared/file-mode.ts`: code/prose classification.
- `src/browser/fim-module/fim-inline-provider.ts`: FIM trigger/data/render provider.
- `src/browser/sweep/trigger-layer/sweep-controller.ts`: active NES trigger/controller.
- `src/browser/sweep/data-gathering-layer/sweep-edit-history-recorder.ts`: Monaco edit history adapter.
- `src/browser/sweep/data-gathering-layer/sweep-context-collector.ts`: context collector.
- `src/browser/sweep/data-gathering-layer/sources/*`: related context sources.
- `src/browser/sweep/data-formatting-layer/sweep-request-builder.ts`: editor snapshot and RPC request builder.
- `src/browser/nes-render/nes-view-zone-renderer.ts`: active NES View Zone renderer.
- `src/browser/nes-module/nes-controller.ts`: re-export of SweepController.
- `src/browser/nes-module/nes-view-zone-renderer.ts`: re-export of NES renderer.
- `src/browser/embedding/config-sync.ts`: frontend embedding config/workspace sync.
- `src/browser/embedding/index-client.ts`: backend index status receiver.
- `src/browser/status-bar/status-bar.ts`: index status bar.

Backend:

- `src/node/smart-completions-backend-module.ts`: backend DI and RPC handlers.
- `src/node/services/fim-backend-service.ts`: FIM backend orchestration.
- `src/node/services/nes-backend-service.ts`: NES backend facade and Sweep routing.
- `src/node/services/embedding-index-service.ts`: embedding RPC service and shared retrieval access.
- `src/node/fim-module/context-formation/*`: FIM prompt specs/building/trimming.
- `src/node/fim-module/model-call/*`: FIM llama.cpp client and postprocess.
- `src/node/sweep/sweep-backend-service.ts`: Sweep backend orchestration.
- `src/node/sweep/data-formatting-layer/*`: Sweep trimming, diagnostics, file blocks and diff blocks.
- `src/node/sweep/prompt-creating-layer/sweep-prompt-builder.ts`: Sweep training-format prompt builder.
- `src/node/sweep/model-call-layer/*`: Sweep llama.cpp client and response parser.
- `src/node/nes-module/context-formation/builder.ts`: generic NES/Sweep/Zeta prompt builder.
- `src/node/nes-module/model-call/*`: generic NES client/parser.
- `src/node/embedding-module/embedding-service.ts`: embedding pipeline composition.
- `src/node/embedding-module/indexer/*`: repo indexing, ignore and persistence.
- `src/node/embedding-module/chunker/*`: tree-sitter/prose chunking.
- `src/node/embedding-module/embed-client/llama-embed-client.ts`: embeddings API client.
- `src/node/embedding-module/vector-store/*`: BM25, LanceDB, ChromaDB, vector interfaces.
- `src/node/embedding-module/retriever/hybrid-retriever.ts`: vector + BM25 + RRF retrieval.
- `src/node/util/*`: hash and CRLF utilities.

## 16. Verified Current Behavior

Recent battlefield verification established:

- Sweep models `7B`, `1.5B`, `0.5B` were tested through LanceDB RAG.
- Embeddings tested: granite, jina-code 0.5B, jina-code 1.5B, embeddinggemma 300M.
- Matrix result: `12/12` runs passed, each with `22/22` invariants.
- Validated report path: `smart-completions/test_results/battlefield-matrix-20260626-004132-corrected-all/summary.md`.

## 17. Operational Requirements

External services must be available and configured by URL:

- FIM `llama.cpp` server at `smart-completions.fim.llamaUrl`.
- NES `llama.cpp` server at `smart-completions.nes.llamaUrl`.
- Embedding `llama.cpp` server at `smart-completions.embedding.llamaUrl`.
- ChromaDB server only when `smart-completions.embedding.vectorDb = chromadb`.

For raw completions, `llama.cpp` must expose OpenAI-compatible `/v1/completions` or equivalent base URL ending before `/completions`.

For embeddings, `llama.cpp` must expose `/v1/embeddings` or equivalent base URL ending before `/embeddings`.

## 18. Current Limitations

- Preferences schema exposes no per-model nested configuration objects; one active FIM, one active NES and one embedding config are active at a time.
- FIM `contextSources.recentEdits` and `contextSources.diagnostics` are configured but not currently gathered by `FimBackendServiceImpl`.
- Active NES frontend is Sweep-oriented; Zeta backend code exists but the active controller/request builder is Sweep-shaped.
- NES render is View Zone only in active path; no active NES ghost-text renderer.
- `nes-priority` is declared but not implemented as a distinct priority algorithm.
- Prompt token budgeting is char-estimated, not tokenizer-exact.
- Prose support is implemented structurally; quality depends on code-trained FIM/NES models.
- The plugin does not manage model process lifecycle, GPU memory or port conflicts.
