# Спецификация: CodeGraph + Fuzzy + SQLite в модуль Sweep

Версия под текущий код (commit `86fa8cb`). Цель: добавить два retrieval-канала — **CodeGraph** (структурный, на SQLite) и **Fuzzy** (по идентификаторам) — в модуль Sweep, гармонично слить их с уже существующим семантическим каналом (LanceDB+BM25) и уже реализованным reranker'ом, не трогая FIM/Zeta и общий слой. Дополнительно: где взять прекомпилированные грамматики **Nix** и **Nim**, и как всё это собрать так, чтобы плагин строился со всеми зависимостями, а пользователю оставалось только поставить llama.cpp и скачать модели.

---

## 0. Текущее состояние кода (что уже есть)

Проверено по репозиторию:

- **Модуль Sweep** разнесён по трём слоям: `src/common/sweep/` (общие типы Sweep), `src/node/sweep/` (бэкенд-логика), `src/browser/sweep/` (фронт). Вместе это и есть модуль Sweep. Глобальный `src/common/` (`editor-dto`, `embedding-types`, `model-types`) — это кросс-модульный слой.
- **Retrieval Sweep** уже имеет слот: `src/node/sweep/retrieval/rerank/sweep-reranker-client.ts`.
- **Точка retrieval** — `SweepBackendService.retrieveNeighbors()` (`src/node/sweep/sweep-backend-service.ts`, ~строка 166). Сейчас она строит edit-signal запрос (`buildSweepRetrievalQuery`), зовёт `this.embedding.retrieve(query, topN, signal)` (семантический канал) и **внутри себя** запускает reranker (`retrieveRrfNeighbors` → `rerankNeighbors`). **Оркестратора нет.**
- **Семантический канал** — `EmbeddingIndexServiceImpl.retrieve()` (`src/node/services/embedding-index-service.ts`), поверх `EmbeddingService` (LanceDB вектор + BM25 → RRF). **Шарится с FIM** — трогать нельзя.
- **Тип результата** — `Neighbor { filePath, startLine, endLine, text, score }` (`src/common/embedding-types.ts`).
- **Сигналы** — `src/common/sweep/signals.ts` экспортирует `symbolAtCursor`, `importedSymbols`, `declaredTypeNames`, `testNames`, `diagnosticSymbols`, `renamedSymbols`, `recentEditDiffTail`. Их переиспользуем для построения запросов к новым каналам.
- **tree-sitter уже используется** в `src/node/sweep/model-call-layer/syntax-gate.ts` (паттерн: `Parser.init({ locateFile })`, `Parser.Language.load(require.resolve('tree-sitter-wasms/out/tree-sitter-<grammar>.wasm'))`). Версии: `web-tree-sitter@0.20.8` + `tree-sitter-wasms@0.1.13`. **Не менять** (ABI-завязка, см. §9).
- **Lifecycle индексации** — фронт `src/browser/embedding/config-sync.ts`: `workspace.tryGetRoots()` → `indexService.configure(config, roots)` на смену воркспейса, `indexService.reindexFile(uri)` на изменение файла. Этот же хук используем для графа.
- **DI node** — `src/node/smart-completions-backend-module.ts` (`ContainerModule`, `bind(X).toSelf().inSingletonScope()`).
- **Финализация контекста** — `dedupeContextFiles` (`src/common/sweep/dedup-context.ts`) и `trimSweepContext` (`src/node/sweep/data-formatting-layer/context-trimmer.ts`); `neighbors` уходят в `buildSweepPrompt`.
- **package.json**: уже есть нативный `@lancedb/lancedb` (Node-API, prebuilds — собирается без rebuild), `lru-cache`, `web-tree-sitter`, `tree-sitter-wasms`. Сборка: `tsc -b && copy-resources` (копирует `resources/` → `lib/resources/`).
- **CodeGraph/Fuzzy/SQLite сейчас НЕ существуют** в коде (несмотря на сообщение коммита). Их и добавляем.

---

## 1. Архитектурные принципы

1. **Автономность модуля Sweep.** Весь код CodeGraph и Fuzzy живёт **внутри модуля Sweep** (`src/node/sweep/retrieval/…`, типы — `src/common/sweep/…`). В глобальный `src/common/` ничего sweep-специфичного не кладём — туда только то, что идентично во всех модулях.
2. **LanceDB и FIM не трогаем.** `EmbeddingService`/`EmbeddingIndexServiceImpl`/`HybridRetriever`/`RepoIndexer` не модифицируются. Семантический канал зовётся как есть.
3. **Живой граф (dirty-aware) для открытых вкладок.** CodeGraph обновляется не только при сохранении, но и при наборе в любом открытом редакторе — чтобы NES в текущей вкладке видел свежую структуру несохранённых буферов в *других* вкладках. Содержимое несохранённого буфера есть только на фронте, поэтому открытые редакторы шлют живой `source` на бэкенд (дебаунс ~400ms), а полный индекс и файлы вне редактора бэкенд читает с диска сам (вариант 2 как база). **Асимметрия с вектором осознанная:** tree-sitter-парс одного файла дёшев (единицы мс) → живые обновления графа по дебаунсу набора affordable; эмбеддинг дорог (вызов модели на чанк) → вектор-индекс остаётся save-driven. Каналы имеют разную свежесть by design: граф даёт точный live-структурный сигнал, вектор — семантический recall по стабильному корпусу.
4. **Каналы → merge → rerank.** Все каналы выдают `Neighbor[]`, сливаются единым RRF (k=60), затем проходят уже готовый reranker. Reranker-вызов **переезжает** из `retrieveNeighbors` в оркестратор, после merge.
5. **Флаги, дефолт off.** При выключенных каналах поведение байт-в-байт = текущему. Включается по одному.
6. **`finalTopN` не растёт.** Каналы повышают релевантность пула, не его размер — иначе крадут бюджет у триады/recent edits.
7. **Универсальность NES (код и проза).** CodeGraph и Fuzzy — **code-only**: на typst/markdown/latex/plaintext символьного графа нет, поэтому они запускаются только при `fileMode==='code'`. Проза обслуживается семантическим каналом S (он уже работает для прозы) — качество прозовых подсказок не меняется. Это требование корректности, а не опция.
8. **Сборка со всеми зависимостями.** SQLite берём нативной сборкой (`better-sqlite3`) — быстрее и disk-backed. Это добавляет один нативный модуль (как уже есть `@lancedb/lancedb`), который собирается под ABI Electron **на этапе сборки приложения** через `@electron/rebuild` (Theia это поддерживает). Конечному пользователю это незаметно: он получает уже собранный `.node` в упакованном приложении и ставит только llama.cpp + модели. Грамматики Nix/Nim остаются прекомпилированными WASM и бандлятся как ресурсы (как tree-sitter уже сейчас) — без нативной сборки.

---

## 2. Целевая архитектура

```
SweepBackendService.predict()
  └─ retrieveNeighbors(request, windowText)
        └─ SweepRetrievalOrchestrator.retrieve(input)        ← НОВОЕ
              ├─ channel S: embedding.retrieve(query, poolN)  [LanceDB+BM25]  ← НЕ трогаем
              ├─ channel G: SweepGraphChannel.retrieve(...)   [SQLite граф]   ← НОВОЕ
              ├─ channel F: SweepFuzzyChannel.retrieve(...)    [fuzzysort]     ← НОВОЕ
              ├─ mergeNeighborChannels([S,G,F], poolN)         [RRF k=60]      ← НОВОЕ
              └─ reranker (ambiguity-gated, fail-open)         [уже есть]      ← ПЕРЕЕЗЖАЕТ сюда
        → dedupeContextFiles → buildSweepPrompt (как сейчас)
```

Индексация — **два пути** (граф живой для открытых вкладок, save-driven для остального):

```
A. Полный индекс + файлы, изменённые на диске вне редактора (вариант 2 — бэкенд читает сам):
config-sync (frontend)
  ├─ indexService.configure(roots)             [embedding, как сейчас]
  └─ sweepGraphClient.configure(roots)          ← НОВОЕ (тот же хук)
        └─ SweepGraphIndexer: walk → readFile(disk) → tree-sitter → symbols+refs → SQLite (WAL)
                                                └→ fuzzysort catalog (full rebuild)

B. ЖИВЫЕ правки открытых редакторов (dirty-aware — содержимое только на фронте):
SweepGraphLiveRecorder (frontend, зеркалит SweepEditHistoryRecorder)
  monaco.editor.getModels() + onDidCreateModel
    └─ model.onDidChangeContent → debounce(~400ms) → sweepGraphClient.reindexFile(uri, source, languageId)
    └─ model.onWillDispose (закрытие без сохранения) → reindexFile(uri)  // без source → бэкенд читает диск (откат к сохранённому)
        └─ SweepGraphIndexer.reindexFile(uri, source?, languageId?): SQLite delete+insert + fuzzy.updateFile (инкрементально)
```

Так структура несохранённых буферов в *других вкладках* попадает в граф к следующему NES-запросу; вектор-индекс остаётся save-driven.

---

## 3. Зависимости: что ставить и как бандлить

### 3.1 SQLite — better-sqlite3 (нативный, выбран опросом)

**Решение: `better-sqlite3` (нативный, синхронный, disk-backed).** Быстрее sql.js и пишет прямо на диск (без экспорта буфера). Платой идёт нативная сборка под ABI Electron — её закрываем `@electron/rebuild` на этапе сборки приложения, так что конечному пользователю ничего собирать не нужно.

| Критерий | better-sqlite3 (выбран) |
|---|---|
| Тип | нативный (N-API/node-gyp), синхронный |
| Хранение | файл на диске (без сериализации буфера) |
| Скорость записи/чтения | высокая; батч-вставка в транзакции |
| Сборка | `@electron/rebuild` под версию Electron (build-time, не у пользователя) |
| FTS5 | есть, но **не нужен** (точные запросы — equality по индексу; нечёткий поиск — fuzzysort, §6) |

Установка:
```bash
npm install better-sqlite3@^11.0.0
npm install --save-dev @types/better-sqlite3
```

`better-sqlite3` поставляет prebuilt-бинарники под Node, но **под Electron его нужно пересобрать** (другой ABI). Это делается один раз на этапе сборки Theia-приложения, а не пользователем. Весь код графа изолирован за интерфейсом `SweepGraphStore`, поэтому движок при необходимости заменяется одной реализацией без изменений в каналах.

Производительность: для горячего пути включаем WAL и готовим prepared statements один раз. Батч-индексация оборачивается в транзакцию (`db.transaction(...)`) — на порядок быстрее построчных вставок.

### 3.2 Fuzzy — fuzzysort (pure JS, без нативного)

```bash
npm install fuzzysort@^3.1.0
```
`fuzzysort` — чистый JS, нулевая нативная зависимость, бандлится обычным образом. Работает над in-memory массивом имён символов.

### 3.3 Грамматики Nix/Nim

Прекомпилированные WASM. Бандлятся как ресурсы (`resources/grammars/`), нативной сборки не требуют.

### 3.4 Итог по package.json

```jsonc
"dependencies": {
  // ...существующее...
  "better-sqlite3": "^11.0.0",
  "fuzzysort": "^3.1.0"
}
```
`fuzzysort` — без нативной компиляции. `better-sqlite3` — нативный, пересобирается под Electron на этапе сборки приложения. `@types/better-sqlite3` в devDependencies.

---

## 4. SQLite-слой: SweepGraphStore

Файл: `src/node/sweep/retrieval/graph/sweep-graph-store.ts`.

### 4.1 Схема

Одна БД обслуживает граф и каталог символов (для fuzzy):

```sql
CREATE TABLE IF NOT EXISTS symbols (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,           -- имя символа (функция/тип/переменная)
  kind      TEXT NOT NULL,           -- 'function' | 'type' | 'class' | 'variable' | ...
  file      TEXT NOT NULL,           -- путь файла
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  body      TEXT NOT NULL            -- обрезанное тело символа (для возврата Neighbor без чтения файла)
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);

CREATE TABLE IF NOT EXISTS refs (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,           -- имя, на которое ссылаются (вызов/использование)
  file      TEXT NOT NULL,           -- файл, где встретилась ссылка
  line      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);
CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file);
```

Граф «кто кого вызывает» получается join'ом `refs.name = symbols.name`. Каталог для fuzzy — это `SELECT DISTINCT name, kind, file, start_line, end_line FROM symbols`.

### 4.2 Интерфейс и реализация (better-sqlite3)

```ts
// src/node/sweep/retrieval/graph/sweep-graph-store.ts
import Database from 'better-sqlite3';

export interface SymbolRow { name: string; kind: string; file: string; startLine: number; endLine: number; body: string; }
export interface RefRow { name: string; file: string; line: number; }

/** Абстракция хранилища графа — изолирует движок (better-sqlite3) от каналов. */
export interface SweepGraphStore {
    reset(): void;                                            // пересоздать пустую схему
    insertSymbols(rows: SymbolRow[]): void;                   // батч в транзакции
    insertRefs(rows: RefRow[]): void;
    deleteFile(file: string): void;                           // удалить символы/ссылки файла (для reindex)
    declarationsByName(name: string, limit: number): SymbolRow[];
    referencesToName(name: string, limit: number): RefRow[];  // файлы, ссылающиеся на name
    namesReferencedByFile(file: string, limit: number): string[];
    allSymbolNames(): { name: string; kind: string; file: string; startLine: number; endLine: number }[]; // для fuzzy-каталога
    dispose(): void;
}

/** better-sqlite3-реализация: синхронная, пишет прямо в файл; persist не нужен (данные на диске). */
export class BetterSqlite3GraphStore implements SweepGraphStore {
    private readonly db: Database.Database;

    /** Открывает/создаёт БД по пути; включает WAL и схему. Синхронно — better-sqlite3 не async. */
    constructor(dbFilePath: string) {
        this.db = new Database(dbFilePath);
        this.db.pragma('journal_mode = WAL');                 // быстрее на инкрементальных записях
        this.db.pragma('synchronous = NORMAL');
        this.db.exec(SCHEMA_SQL);                             // CREATE TABLE/INDEX IF NOT EXISTS
    }

    reset(): void { this.db.exec('DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS refs;'); this.db.exec(SCHEMA_SQL); }

    insertSymbols(rows: SymbolRow[]): void {
        const stmt = this.db.prepare('INSERT INTO symbols(name,kind,file,start_line,end_line,body) VALUES (?,?,?,?,?,?)');
        const many = this.db.transaction((rs: SymbolRow[]) => { for (const r of rs) stmt.run(r.name, r.kind, r.file, r.startLine, r.endLine, r.body); });
        many(rows);                                           // батч-вставка в одной транзакции
    }
    // insertRefs — аналогично через transaction; deleteFile — DELETE FROM symbols/refs WHERE file=?

    declarationsByName(name: string, limit: number): SymbolRow[] {
        return this.db.prepare('SELECT name,kind,file,start_line AS startLine,end_line AS endLine,body FROM symbols WHERE name=? LIMIT ?').all(name, limit) as SymbolRow[];
    }
    referencesToName(name: string, limit: number): RefRow[] {
        return this.db.prepare('SELECT name,file,line FROM refs WHERE name=? LIMIT ?').all(name, limit) as RefRow[];
    }
    // namesReferencedByFile, allSymbolNames — аналогично через .all()

    dispose(): void { this.db.close(); }
}
```

better-sqlite3 синхронный → создание store без `await`, упрощает индексатор. Все запросы — точечные по индексу (`idx_symbols_name`, `idx_refs_name`, `idx_refs_file`), на горячем пути sub-ms. Батч-вставка в транзакции — на порядок быстрее построчной.

---

## 5. CodeGraph: индексатор и канал

### 5.1 Извлечение символов/ссылок (tree-sitter)

Файл: `src/node/sweep/retrieval/graph/sweep-graph-extractor.ts`. Зеркалит паттерн `syntax-gate.ts`, но **внутри модуля Sweep** (свой loader, чтобы не зависеть от embedding-module).

```ts
// src/node/sweep/retrieval/graph/sweep-tree-sitter-loader.ts
import Parser from 'web-tree-sitter';

/** Sweep-локальный tree-sitter loader: автономен от embedding-module, грузит WASM из bundled-ресурсов. */
export class SweepTreeSitter {
    private parser: Parser | undefined;
    private initialized = false;
    private readonly languages = new Map<string, unknown>();

    async ensureInit(): Promise<Parser> {
        if (!this.initialized) {
            await Parser.init({ locateFile: (f: string) => require.resolve(`web-tree-sitter/${f}`) });
            this.parser = new Parser();
            this.initialized = true;
        }
        return this.parser!;
    }

    /** Грузит грамматику: сначала bundled resources/grammars (Nix/Nim), потом tree-sitter-wasms. */
    async loadLanguage(grammar: string): Promise<unknown> {
        let lang = this.languages.get(grammar);
        if (!lang) {
            const wasmPath = resolveGrammarWasm(grammar);    // см. §9.4
            const loader = (Parser as unknown as { Language: { load(p: string): Promise<unknown> } }).Language;
            lang = await loader.load(wasmPath);
            this.languages.set(grammar, lang);
        }
        return lang;
    }
}
```

Извлечение через tree-sitter queries (по грамматике): объявления (function/type/class/variable definitions) → `symbols`, идентификаторы-вызовы → `refs`. Для каждой грамматики — небольшой набор `.scm`-паттернов (declaration captures + reference captures). Для языков без точных паттернов — fallback: эвристика по именованным узлам (имя + диапазон). `body` обрезается до N символов (например, 1500), чтобы канал возвращал `Neighbor.text` без чтения файла.

```ts
// src/node/sweep/retrieval/graph/sweep-graph-extractor.ts
export interface ExtractedFile { symbols: SymbolRow[]; refs: RefRow[]; }

/** Парсит один файл и извлекает символы/ссылки; пустой результат при неподдержанной грамматике. */
export async function extractGraphFromFile(ts: SweepTreeSitter, file: string, source: string, languageId: string, maxBodyChars: number): Promise<ExtractedFile> {
    const grammar = sweepGrammarForLanguage(languageId);     // §9.4 (включает nix/nim)
    if (!grammar) return { symbols: [], refs: [] };
    const parser = await ts.ensureInit();
    parser.setLanguage(await ts.loadLanguage(grammar) as Parameters<Parser['setLanguage']>[0]);
    const tree = parser.parse(source);
    // обход дерева: declaration-узлы → SymbolRow (name,kind,file,start,end,body=clip(source[start..end]))
    //               identifier-узлы в call/reference позиции → RefRow (name,file,line)
    return { symbols, refs };
}
```

### 5.2 Индексатор и lifecycle (зеркало embedding-индекса)

Файл: `src/node/sweep/retrieval/graph/sweep-graph-indexer.ts`. DI-синглтон.

```ts
@injectable()
export class SweepGraphIndexer {
    private store: SweepGraphStore | undefined;
    private readonly ts = new SweepTreeSitter();
    private roots: string[] = [];
    private dbPath = '';                                       // <cacheDir>/sweep-graph.sqlite

    // Индексатор владеет обновлением fuzzy-каталога: полный rebuild на индексации, инкрементально на reindex.
    constructor(@inject(SweepFuzzyChannel) private readonly fuzzy: SweepFuzzyChannel) {}

    /** Конфигурирует индексатор воркспейс-рутами и открывает/строит граф (вызывается с того же хука, что embedding). */
    async configure(roots: string[], cacheDir: string, enabled: boolean): Promise<void> {
        if (!enabled) { this.dispose(); return; }
        this.roots = roots;
        this.dbPath = path.join(cacheDir, 'sweep-graph.sqlite');
        const fresh = !fs.existsSync(this.dbPath);
        this.store = new BetterSqlite3GraphStore(this.dbPath);  // синхронно, открывает/создаёт файл
        if (fresh) await this.fullIndex();                      // первая индексация (иначе граф уже на диске)
        else this.fuzzy.rebuild(this.store.allSymbolNames());   // каталог fuzzy строим из существующего графа (полный rebuild)
    }

    /** Полный обход воркспейса (как indexOnOpen у embedding), с уважением к .gitignore (reuse существующего ignore). */
    private async fullIndex(): Promise<void> {
        this.store!.reset();
        for await (const file of walkFiles(this.roots)) {     // reuse паттерна обхода/ignore из embedding-module если вынесен, иначе локальный
            const { symbols, refs } = await extractGraphFromFile(this.ts, file.path, file.text, file.languageId, MAX_BODY_CHARS);
            this.store!.insertSymbols(symbols); this.store!.insertRefs(refs);  // каждая вставка — транзакция
        }
        this.fuzzy.rebuild(this.store!.allSymbolNames());     // §6 — полный rebuild каталога после полной индексации
    }

    /**
     * Инкрементальный reindex одного файла. `source` задан (живой буфер с фронта) → используем его;
     * не задан (watch-событие на диске / закрытие редактора) → читаем диск (откат к сохранённому). См. §8.5.
     */
    async reindexFile(uri: string, source?: string, languageId?: string): Promise<void> {
        if (!this.store) return;
        const abs = uriToFsPath(uri);
        this.store.deleteFile(abs);
        let text = source;
        if (text === undefined) {
            try { text = normalizeCrlf(await fs.promises.readFile(abs, 'utf8')); }
            catch { this.fuzzy.removeFile(abs); return; }     // файл удалён → снять из графа и из fuzzy-каталога
        }
        const lang = languageId ?? languageIdForExtension(path.extname(abs));
        const { symbols, refs } = await extractGraphFromFile(this.ts, abs, text, lang, MAX_BODY_CHARS);
        this.store.insertSymbols(symbols); this.store.insertRefs(refs);  // WAL; проза/неподдержанное → пустой extract (no-op)
        this.fuzzy.updateFile(abs, symbols);                  // инкрементально: только записи этого файла, без полного rebuild
    }

    getStore(): SweepGraphStore | undefined { return this.store; }
    dispose(): void { this.store?.dispose(); this.store = undefined; }
}
```

`cacheDir` — sweep-специфичная папка кэша (например, рядом с embedding-индексом, но отдельная: `<workspaceStorage>/sweep-graph/`). Персистентность — **прямо на диск** (better-sqlite3, WAL): отдельного шага сериализации/записи буфера нет, на старте просто открываем существующий файл.

### 5.3 Канал G

Файл: `src/node/sweep/retrieval/graph/sweep-graph-channel.ts`.

```ts
/** Структурный канал: по символам edit-сигнала находит объявления и связанные файлы из графа. */
export class SweepGraphChannel {
    constructor(private readonly indexer: SweepGraphIndexer) {}

    /** Возвращает Neighbor[] по графу: объявления искомых символов + файлы, ссылающиеся на них. */
    retrieve(signals: GraphQuerySignals, topN: number): Neighbor[] {
        const store = this.indexer.getStore();
        if (!store) return [];
        const names = dedupe([signals.cursorSymbol, ...signals.renamedSymbols, ...signals.diagnosticSymbols, ...signals.importedSymbols].filter(Boolean));
        const out: Neighbor[] = [];
        for (const name of names) {
            // 1) объявления символа
            for (const s of store.declarationsByName(name, GRAPH_DECL_LIMIT)) {
                out.push({ filePath: s.file, startLine: s.startLine, endLine: s.endLine, text: s.body, score: 1 });
            }
            // 2) файлы, ссылающиеся на символ (callers) — даём «окно» вокруг ссылки или объявление родителя
            for (const r of store.referencesToName(name, GRAPH_REF_LIMIT)) {
                // при желании: подтянуть объявление, охватывающее r.line, либо вернуть узкий диапазон строки
            }
        }
        return rankAndClip(out, topN);   // ранжируем по числу совпадений/виду символа, режем до topN
    }
}
```

`GraphQuerySignals` строится из `signals.ts`: `symbolAtCursor`, `renamedSymbols`, `diagnosticSymbols`, `importedSymbols`. Канал **синхронный** (SQLite-запросы) — на горячем пути дёшев.

> **Честная граница:** часть «callers/callees» пересекается с уже существующим LSP `HierarchyRelatedSource`. Реальная добавочная ценность графа — offline/без-LSP, неподдержанные LSP языки (Nix/Nim!), и batch-обход всего репозитория. Поэтому канал G особенно оправдан именно для Nix/Nim, где LSP может отсутствовать.

---

## 6. Fuzzy: канал F

Файл: `src/node/sweep/retrieval/fuzzy/sweep-fuzzy-channel.ts`. Каталог имён держим in-memory (строится индексатором из `store.allSymbolNames()`), запросы — через fuzzysort.

```ts
import fuzzysort from 'fuzzysort';

export interface FuzzyEntry { name: string; kind: string; file: string; startLine: number; endLine: number; prepared: Fuzzysort.Prepared; }

/** Нечёткий канал по идентификаторам: короткие имена/опечатки, которые вектор и BM25 пропускают. */
export class SweepFuzzyChannel {
    private entries: FuzzyEntry[] = [];

    /** Полный rebuild каталога из всех символов графа (вызывается на полной (ре)индексации). */
    rebuild(symbols: { name: string; kind: string; file: string; startLine: number; endLine: number }[]): void {
        this.entries = symbols.map(s => ({ ...s, prepared: fuzzysort.prepare(s.name) }));
    }

    /** Инкрементально: заменяет записи одного файла (живой reindex по набору). Re-prepare только имён этого файла. */
    updateFile(file: string, symbols: { name: string; kind: string; file: string; startLine: number; endLine: number }[]): void {
        const kept = this.entries.filter(e => e.file !== file);          // выкидываем старые записи файла
        for (const s of symbols) kept.push({ ...s, prepared: fuzzysort.prepare(s.name) });
        this.entries = kept;                                             // unchanged-имена НЕ re-prepare → дёшево на горячем пути набора
    }

    /** Инкрементально: убирает все записи файла (закрытие/удаление). */
    removeFile(file: string): void { this.entries = this.entries.filter(e => e.file !== file); }

    /** Возвращает Neighbor[] по нечёткому совпадению имён символов с символами edit-сигнала. */
    retrieve(querySymbols: string[], topN: number): Neighbor[] {
        const seen = new Set<string>(); const out: Neighbor[] = [];
        for (const q of dedupe(querySymbols.filter(Boolean))) {
            const hits = fuzzysort.go(q, this.entries, { key: 'name', limit: FUZZY_PER_SYMBOL, threshold: FUZZY_THRESHOLD });
            for (const h of hits) {
                const e = h.obj; const key = `${e.file}:${e.startLine}`;
                if (seen.has(key)) continue; seen.add(key);
                out.push({ filePath: e.file, startLine: e.startLine, endLine: e.endLine, text: '', score: normalize(h.score) });
            }
        }
        return out.slice(0, topN);   // text='' → дочитается на этапе finalize, либо канал хранит body в каталоге
    }
}
```

Опционально: разбиение составных идентификаторов (`camelCase`/`snake_case`) на под-токены перед `fuzzysort.go`, чтобы `getUserName` матчил запрос `user`. Реализуется маленьким `splitIdentifier()` в `src/node/sweep/retrieval/fuzzy/identifier-tokenize.ts`. fuzzysort — pure JS, на горячем пути микросекунды.

> **Граница:** Fuzzy — самый узкий канал. Включать после того, как G покажет ценность, и мерить отдельно.

---

## 7. Merge и оркестратор

### 7.1 mergeNeighborChannels

Файл: `src/node/sweep/retrieval/merge.ts`. Тот же RRF, что в семантическом канале (k=60), ключ дедупа `filePath:startLine:endLine`.

```ts
const RRF_K = 60;
/** Сливает несколько каналов Neighbor[] через Reciprocal Rank Fusion; ключ — filePath:start:end. */
export function mergeNeighborChannels(channels: Neighbor[][], topN: number): Neighbor[] {
    const acc = new Map<string, { n: Neighbor; score: number }>();
    for (const list of channels) {
        for (let rank = 0; rank < list.length; rank++) {
            const n = list[rank]; const key = `${n.filePath}:${n.startLine}:${n.endLine}`;
            const add = 1 / (RRF_K + rank + 1);
            const cur = acc.get(key);
            if (cur) cur.score += add; else acc.set(key, { n, score: add });
        }
    }
    return [...acc.values()].sort((a, b) => b.score - a.score).slice(0, topN).map(e => ({ ...e.n, score: e.score }));
}
```

### 7.2 SweepRetrievalOrchestrator

Файл: `src/node/sweep/retrieval/sweep-retrieval-orchestrator.ts`. Сюда **переезжает** rerank-шаг.

```ts
// fileMode — из request.mode/SweepRequest; различает код и прозу (typst/markdown/latex/plaintext).
export interface OrchestratorInput { query: string; fileMode: FileMode; signals: GraphQuerySignals; fuzzySymbols: string[]; topN: number; signal?: AbortSignal; }

@injectable()
export class SweepRetrievalOrchestrator {
    constructor(
        private readonly embedding: EmbeddingIndexServiceImpl,   // канал S (НЕ трогаем)
        private readonly graph: SweepGraphChannel,                // канал G
        private readonly fuzzy: SweepFuzzyChannel,                // канал F
        private readonly reranker: SweepRerankerClient,           // уже существует
    ) {}

    /** S+G+F → merge(RRF) → (ambiguity-gated) rerank → finalTopN. Каналы G/F — code-only И флаг-гейтятся в config. */
    async retrieve(input: OrchestratorInput, cfg: SweepRetrievalConfig): Promise<Neighbor[]> {
        const finalTopN = Math.max(1, Math.min(cfg.rerank.finalTopN, input.topN));
        const poolN = Math.max(finalTopN, cfg.rerank.candidatePoolN);

        // УНИВЕРСАЛЬНОСТЬ: CodeGraph/Fuzzy осмысленны только для кода. Для прозы (typst/markdown/latex/plaintext)
        // символьного графа нет → каналы G/F НЕ запускаем, прозу несёт только семантический канал S.
        const codeMode = input.fileMode === 'code';

        const channels: Neighbor[][] = [];
        channels.push(await this.embedding.retrieve(input.query, poolN, input.signal));        // S — всегда (код и проза)
        if (codeMode && cfg.graph.enabled) channels.push(this.graph.retrieve(input.signals, poolN));     // G — только код
        if (codeMode && cfg.fuzzy.enabled) channels.push(this.fuzzy.retrieve(input.fuzzySymbols, poolN)); // F — только код

        const merged = mergeNeighborChannels(channels, poolN);

        if (!cfg.rerank.enabled || this.rerankerBroken || !isAmbiguous(merged, cfg.rerank.ambiguityMargin, finalTopN)) {
            return merged.slice(0, finalTopN);
        }
        try {
            return await this.rerankNeighbors(merged, input.query, cfg.rerank, finalTopN, input.signal);  // как в backend сейчас
        } catch (e) {
            LOG.warn('Sweep rerank failed, falling back to merged order', { error: String(e) });
            return merged.slice(0, finalTopN);
        }
    }
}
```

`rerankNeighbors`, `isAmbiguous`, `looksBroken`, `buildSweepRerankQuery`, `clipRerankDocument`, флаг `rerankerBroken`, `warmup` — **переносятся из `sweep-backend-service.ts` в оркестратор без изменения логики** (они уже корректны: prefix-срез документов, валидный index-mapping, fail-open). Это рефакторинг-перенос, а не переписывание.

---

## 8. Интеграция в существующий код (точечно)

### 8.1 `sweep-backend-service.ts`

Сейчас `retrieveNeighbors` сам зовёт embedding + rerank. После: он строит сигналы и делегирует оркестратору.

```ts
// БЫЛО (упрощённо):
//   const neighbors = await this.embedding.retrieve(query, options.topN, signal);
//   ... + rerankNeighbors внутри ...

// СТАНЕТ:
private async retrieveNeighbors(request: SweepRequest, windowText: string, signal?: AbortSignal): Promise<Neighbor[]> {
    const options = this.embedding.getRetrievalOptions();
    const query = buildSweepRetrievalQuery({
        recentEdits: request.recentEdits, windowText,
        cursorOffset: request.cursorOffset, diagnostics: request.diagnostics,
        maxChars: this.config.queryMaxChars || options.prefixTailChars,
    });
    if (!query.trim() || options.topN <= 0) return [];

    // сигналы для каналов G/F из существующего signals.ts
    const signals: GraphQuerySignals = {
        cursorSymbol: symbolAtCursor(windowText, request.cursorOffset),
        renamedSymbols: renamedSymbols(request.recentEdits),
        diagnosticSymbols: diagnosticSymbols(request.diagnostics),
        importedSymbols: importedSymbols(windowText),
    };
    const fuzzySymbols = [signals.cursorSymbol, ...signals.renamedSymbols, ...signals.diagnosticSymbols];

    return this.orchestrator.retrieve(
        { query, fileMode: request.mode, signals, fuzzySymbols, topN: options.topN, signal },
        { rerank: this.config.rerank, graph: this.config.graph, fuzzy: this.config.fuzzy },
    );
}
```

`request.mode` — уже существующий `FileMode` в `SweepRequest` (код vs проза). Для прозы (typst/markdown/latex/plaintext) оркестратор сам отключит G/F и оставит только семантический канал S — сигналы строятся всегда, но просто не используются прозой. Так NES остаётся универсальным: код получает все каналы, проза — семантику, как и сейчас.

Удаляются из backend: `rerankNeighbors`/`warmupReranker`/`isAmbiguous`-вызовы/`rerankerBroken` — **переносятся в оркестратор**. `retrieveRrfNeighbors` остаётся как тонкая обёртка над `embedding.retrieve` либо инлайнится в оркестратор (канал S). FIM/Zeta — без изменений.

### 8.2 Конфиг (`src/common/sweep/types.ts`)

```ts
/** Флаг-гейтинг структурного канала графа (Sweep-only). */
export interface SweepGraphConfig { enabled: boolean; }
/** Флаг-гейтинг нечёткого канала (Sweep-only). */
export interface SweepFuzzyConfig { enabled: boolean; }

export const DEFAULT_SWEEP_GRAPH_CONFIG: SweepGraphConfig = { enabled: false };
export const DEFAULT_SWEEP_FUZZY_CONFIG: SweepFuzzyConfig = { enabled: false };

export interface SweepConfig {
    // ...существующее...
    rerank: SweepRerankConfig;
    graph: SweepGraphConfig;     // НОВОЕ
    fuzzy: SweepFuzzyConfig;     // НОВОЕ
}
```
И зеркально в `NesConfig` (`src/common/nes-types.ts`) — конфиг течёт `prefs → NesConfig → RPC → SweepConfig`, как у rerank (проверено: контроллер читает `NesConfig`, бэкенд — `SweepConfig`). В `readNesConfig` (`preferences-schema.ts`) заполнить `graph`/`fuzzy`.

> **Важно (исправить попутно):** дефолт `DEFAULT_SWEEP_RERANK_CONFIG.llamaUrl` сейчас `http://127.0.0.1:8040/v1` — это порт **эмбеддера**. Reranker по карте инфраструктуры — **8030**. Поправить на `http://127.0.0.1:8030/v1`.

### 8.3 Preferences (`src/browser/preferences/preferences-schema.ts`)

```ts
'smart-completions.nes.graph.enabled': { type: 'boolean', default: false, description: 'Enable Sweep CodeGraph retrieval channel.' },
'smart-completions.nes.fuzzy.enabled': { type: 'boolean', default: false, description: 'Enable Sweep fuzzy symbol retrieval channel.' },
```
+ заполнить `graph`/`fuzzy` в `readNesConfig()`.

### 8.4 DI (`src/node/smart-completions-backend-module.ts`)

```ts
bind(SweepGraphIndexer).toSelf().inSingletonScope();
bind(SweepGraphChannel).toSelf().inSingletonScope();
bind(SweepFuzzyChannel).toSelf().inSingletonScope();
bind(SweepRetrievalOrchestrator).toSelf().inSingletonScope();
// SweepRerankerClient уже создаётся внутри сервиса — можно тоже вынести в DI или оставить как есть
```
Оркестратор инжектит `EmbeddingIndexServiceImpl` (уже забинден), `SweepGraphChannel`, `SweepFuzzyChannel`, `SweepRerankerClient`. `SweepBackendService` инжектит `SweepRetrievalOrchestrator`.

### 8.5 Lifecycle графа: живой (dirty-aware) + save-driven

Два источника обновлений (см. диаграмму §2):

**RPC-сервис** `SweepGraphService` (node): `configure(roots, enabled)` и `reindexFile(uri, source?, languageId?)`. `source` задан → живой буфер с фронта; не задан → бэкенд читает диск (откат к сохранённому, вариант 2). Реализация — `SweepGraphIndexer` (§5.2). RPC-путь и `ConnectionHandler` — по образцу `EMBEDDING_SERVICE_PATH`.

**(A) Полный индекс + диск-watch вне редактора** — в `config-sync.ts`, рядом с embedding:
```ts
// configure графа на том же хуке, что embedding:
await this.indexService.configure(config, roots);
await this.sweepGraphClient.configure(roots, graphOrFuzzyEnabled);          // НОВОЕ

// обработчик ФС-события (git checkout, внешняя правка): реиндексим ТОЛЬКО файлы,
// НЕ открытые в редакторе — открытыми владеет живой рекордер (B), чтобы не затирать dirty диском.
const isOpen = monaco.editor.getModel(monaco.Uri.parse(uri)) != null;
void this.indexService.reindexFile(uri).catch(() => undefined);            // embedding — как сейчас
if (!isOpen) void this.sweepGraphClient.reindexFile(uri).catch(() => undefined);  // НОВОЕ: без source → диск
```

**(B) Живые правки открытых редакторов** — новый `SweepGraphLiveRecorder` (browser, `FrontendApplicationContribution`), **зеркалит `SweepEditHistoryRecorder`** (тот же паттерн трекинга Monaco-моделей):
```ts
// src/browser/sweep/data-gathering-layer/sweep-graph-live-recorder.ts
@injectable()
export class SweepGraphLiveRecorder implements FrontendApplicationContribution, Disposable {
    @inject(SweepGraphClient) private readonly graph!: SweepGraphClient;   // RPC-клиент графа
    private readonly modelDisposables = new Map<string, DisposableCollection>();
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly toDispose = new DisposableCollection();

    onStart(): void {                                                      // как у edit-history recorder
        for (const m of monaco.editor.getModels()) this.track(m);
        this.toDispose.push(monaco.editor.onDidCreateModel(m => this.track(m)));
    }

    private track(model: monaco.editor.ITextModel): void {
        const uri = model.uri.toString();
        if (this.modelDisposables.has(uri)) return;
        if (!isCodeLanguage(model.getLanguageId())) return;               // УНИВЕРСАЛЬНОСТЬ: прозу не шлём (граф code-only)
        const d = new DisposableCollection();
        d.push(model.onDidChangeContent(() => this.schedule(uri, model)));// дебаунс на набор
        d.push(model.onWillDispose(() => {                                // закрытие без сохранения → откат к диску
            this.cancel(uri);
            void this.graph.reindexFile(uri).catch(() => undefined);      // без source → бэкенд читает диск
            this.modelDisposables.get(uri)?.dispose(); this.modelDisposables.delete(uri);
        }));
        this.modelDisposables.set(uri, d);
    }

    /** Дебаунс ~400ms на URI: живой source+language уходят в граф; так несохранённая структура видна следующему NES. */
    private schedule(uri: string, model: monaco.editor.ITextModel): void {
        this.cancel(uri);
        this.timers.set(uri, setTimeout(() => {
            this.timers.delete(uri);
            void this.graph.reindexFile(uri, model.getValue(), model.getLanguageId()).catch(() => undefined);
        }, SWEEP_GRAPH_LIVE_DEBOUNCE_MS));
    }
    private cancel(uri: string): void { const t = this.timers.get(uri); if (t) { clearTimeout(t); this.timers.delete(uri); } }

    dispose(): void { /* очистить timers + modelDisposables + toDispose */ }
}
```
Регистрируется как `FrontendApplicationContribution` в browser-модуле (рядом с `SweepEditHistoryRecorder`).

Итог: набор в другой вкладке (код) → debounce → живой `source` в граф → к следующему NES-запросу в текущей вкладке граф уже знает новые символы/ссылки. Закрытие без сохранения и внешние правки на диске откатывают файл к сохранённому состоянию (бэкенд читает диск). Проза не трекается (граф code-only). `uriToFsPath` для автономности держим sweep-локально. Каналы `SweepGraphChannel`/`SweepFuzzyChannel` читают индексатор синхронно на горячем пути.

---

## 9. Грамматики Nix и Nim (прекомпилированные WASM)

### 9.1 Проблема ABI (критично)

`tree-sitter-wasms@0.1.13` собран `tree-sitter-cli@0.20.8` под ABI, который понимает `web-tree-sitter@0.20.8`. **WASM, собранный новым CLI (0.26.x), не загрузится** в web-tree-sitter 0.20.8 (известная несовместимость ABI). Значит грамматики Nix/Nim надо собрать **CLI, совместимым с 0.20.x ABI**, либо обновлять весь tree-sitter-стек (не рекомендуется — затронет embedding-chunker).

### 9.2 Проверить, нет ли уже в пакете

```bash
ls node_modules/tree-sitter-wasms/out/ | grep -iE 'nix|nim'
```
Если есть `tree-sitter-nix.wasm`/`tree-sitter-nim.wasm` — просто зарегистрировать в карте (§9.4), сборка не нужна. Скорее всего их нет (Nix/Nim — нишевые).

### 9.3 Собрать совместимый WASM

Исходники грамматик:
- **Nix**: `https://github.com/nix-community/tree-sitter-nix`
- **Nim**: `https://github.com/alaviss/tree-sitter-nim`

Сборка с пиннингом CLI под ABI 0.20.x (на NixOS — emscripten из nixpkgs):

```bash
# 1) Совместимый CLI (тот же, что собирал tree-sitter-wasms@0.1.13)
npm install -g tree-sitter-cli@0.20.8

# 2) Тулчейн WASM. На NixOS:
nix shell nixpkgs#emscripten

# 3) Nix
git clone https://github.com/nix-community/tree-sitter-nix && cd tree-sitter-nix
tree-sitter build-wasm .          # старый CLI: команда build-wasm (даёт tree-sitter-nix.wasm)
cd ..

# 4) Nim
git clone https://github.com/alaviss/tree-sitter-nim && cd tree-sitter-nim
tree-sitter build-wasm .
cd ..
```

> На старом CLI команда — `tree-sitter build-wasm` (а не `build --wasm`). Если у грамматики внешний сканер (`scanner.c`), `build-wasm` его подхватит. Nim/Nix имеют внешние сканеры — проверь, что `.wasm` собрался без ошибок линковки.

**Проверка совместимости (обязательно):** прежде чем класть в плагин — загрузить тестом на текущем web-tree-sitter:

```js
const Parser = require('web-tree-sitter');
(async () => {
  await Parser.init();
  const p = new Parser();
  const L = await Parser.Language.load('./tree-sitter-nix.wasm');  // не должно бросить
  p.setLanguage(L);
  console.log(p.parse('{ x = 1; }').rootNode.toString());
})();
```
Если `Language.load` падает — ABI не совпал: пересобрать другим (более старым/совместимым) CLI. Цель — ABI ≤ того, что поддерживает web-tree-sitter 0.20.8.

### 9.4 Положить и зарегистрировать

Положить собранные файлы в бандлируемые ресурсы:
```
resources/grammars/tree-sitter-nix.wasm
resources/grammars/tree-sitter-nim.wasm
```

Sweep-локальная карта языков (включает Nix/Nim) — `src/node/sweep/retrieval/graph/sweep-language-registry.ts`:
```ts
const GRAMMARS: Record<string, string> = {
    typescript: 'typescript', javascript: 'javascript', python: 'python', /* ... как нужно sweep ... */
    nix: 'nix', nim: 'nim',
};
export function sweepGrammarForLanguage(languageId: string): string | undefined { return GRAMMARS[normalize(languageId)]; }
```

Резолвер WASM — сначала bundled `resources/grammars`, потом `tree-sitter-wasms`:
```ts
// §5.1 resolveGrammarWasm:
export function resolveGrammarWasm(grammar: string): string {
    const bundled = path.join(grammarsResourceDir(), `tree-sitter-${grammar}.wasm`);  // lib/resources/grammars
    if (fs.existsSync(bundled)) return bundled;
    return require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
}
```
Так Nix/Nim берутся из bundled-ресурсов, остальное — из `tree-sitter-wasms`, и обновление пакета не ломает кастомные грамматики.

---

## 10. Сборка и упаковка (минимум задач пользователю)

Cборка Theia происходит со всеми зависимостями (включая нативный `better-sqlite3`); **конечный пользователь** получает готовый бинарник и ставит только llama.cpp + модели. Нативная пересборка — этап сборки приложения, не задача пользователя.

### 10.1 Нативная сборка better-sqlite3 под Electron

`better-sqlite3` — нативный модуль. Его prebuilt-бинарники собраны под Node, а Electron имеет другой ABI, поэтому его нужно **пересобрать под версию Electron** того приложения, которое бандлит плагин. Это делается стандартным `@electron/rebuild` (бывший `electron-rebuild`), который Theia-приложения и так используют для нативных модулей (тот же механизм, что уже работает для текущих нативных зависимостей).

В сборке Theia-приложения (не самого extension-пакета, а собирающего его приложения):
```bash
npm install --save-dev @electron/rebuild
# после установки зависимостей, перед упаковкой:
npx electron-rebuild -f -w better-sqlite3
```
Либо через `postinstall`-хук приложения / Theia-таргет, который уже вызывает rebuild нативных модулей. Версия Electron берётся из приложения (`@theia/core` тянет конкретную). Собранный `.node` попадает в упакованное приложение, и пользователю собирать ничего не нужно.

> Проверка: после rebuild `require('better-sqlite3')` в среде Electron приложения должен открываться без `NODE_MODULE_VERSION mismatch`. Если ошибка ABI — rebuild не отработал под нужную версию Electron.

### 10.2 Бандлинг ресурсов (только грамматики)

Нативный `.node` better-sqlite3 не копируется вручную — он резолвится из `node_modules` и пересобирается rebuild'ом. В ресурсы бандлим **только грамматики WASM**. Текущий `copy-resources` (копирует `resources/` → `lib/resources/`) остаётся как есть:

```jsonc
"scripts": {
  "copy-resources": "node -e \"require('node:fs').cpSync('resources','lib/resources',{recursive:true,force:true})\"",
  "build": "tsc -b && npm run copy-resources"
}
```

`grammarsResourceDir()` указывает на `lib/resources/grammars` относительно `__dirname` бандла (§9.4) — Nix/Nim WASM едут с плагином, докачивать ничего не нужно.

### 10.3 Грамматики в `files`

`package.json` `files` уже включает `resources`. Убедиться, что собранные `.wasm` Nix/Nim закоммичены в `resources/grammars/` (бинарные, но небольшие) — тогда они едут с пакетом и не требуют сборки у пользователя. Это и есть «пользователю меньше задач».

---

## 11. Тесты

Раннер: `npm test` = `tsc -p test/tsconfig.json && node --test lib-test/test/*.test.js`. Юнит-тесты всегда; integration — за env-гейтом. Стиль повторяет существующие (`sweep-reranker-client.test.ts`, `battlefield.integration.test.ts`).

### 11.1 Модульные (без серверов и без Theia)

- `test/sweep-graph-store.test.ts` — на временной БД (`better-sqlite3` с временным файлом через `os.tmpdir()`, либо `:memory:` для in-process кейсов): insert symbols/refs → `declarationsByName`/`referencesToName`/`namesReferencedByFile` возвращают ожидаемое; `deleteFile` чистит файл; round-trip персистентности = закрыть store и переоткрыть тот же файл новым `BetterSqlite3GraphStore`, данные на месте. Транзакционная батч-вставка не теряет строки.
- `test/sweep-graph-extractor.test.ts` — на фикстурах исходников (TS, Nix, Nim): извлекаются ожидаемые символы (имя/kind/диапазон) и ссылки; неподдержанный язык → пустой результат. Проверяет, что Nix/Nim WASM реально грузится и парсит (косвенно — тест ABI-совместимости грамматик).
- `test/sweep-fuzzy-channel.test.ts` — `rebuild` каталога + `retrieve`: точное имя матчит, опечатка матчит, нерелевантное отсекается порогом; `splitIdentifier` (`getUserName`→`user` матч); **инкрементально: `updateFile` заменяет записи одного файла (старые имена исчезают, новые находятся), `removeFile` убирает все записи файла** — без полного rebuild. Детерминированный порядок.
- `test/sweep-merge.test.ts` — `mergeNeighborChannels`: дедуп по `file:start:end`, суммирование RRF, общий элемент из двух каналов выше уникальных; срез до topN.
- `test/sweep-orchestrator.test.ts` — с моками каналов (S/G/F как массивы) и моком reranker: при `graph.enabled=false` канал G не зовётся; **при `fileMode!=='code'` (проза) каналы G/F не зовутся даже при `enabled=true`** (универсальность — проза идёт только через S); merge корректен; rerank вызывается только при `isAmbiguous`; fail-open при ошибке reranker; `finalTopN = min(rerank.finalTopN, topN)` не растёт.
- `test/sweep-language-registry.test.ts` — `sweepGrammarForLanguage` для nix/nim/основных, неизвестный → undefined.

### 11.2 Интеграционные (env-гейт, без Theia)

- `test/sweep-graph.integration.test.ts` (гейт `SC_GRAPH_IT=1`, `SC_BATTLE_REPO=/path`): индексирует реальный репо `SweepGraphIndexer`-ом (полный индекс с диска), прогоняет `SweepGraphChannel` по реальным символам, проверяет: символы найдены, callers корректны, латентность запроса (p50/p95), размер БД. Опционально — Nix/Nim файлы в репо парсятся.
- **`test/sweep-graph-live.integration.test.ts`** (гейт `SC_GRAPH_IT=1`): живой путь без редактора — вызвать `SweepGraphIndexer.reindexFile(uri, source, languageId)` с `source`, отличным от содержимого на диске, → граф/каталог отражают **переданный** source (символ из dirty-буфера находится через канал G/F), диск не читался. Затем `reindexFile(uri)` без `source` → откат к диску (dirty-символ исчезает). Удаление файла (`reindexFile` несуществующего uri) → `deleteFile` + `removeFile` из каталога. Это и есть проверка чувствительности к несохранённым буферам других вкладок на уровне бэкенда.
- Расширить `test/battlefield.integration.test.ts` (или новый `test/sweep-channels.battle.test.ts`, гейт `SC_CHANNELS_IT=1`): поднять embedding (+опц. reranker), прогнать **оркестратор** с разными комбинациями каналов (S; S+G; S+G+F) на одних сценариях, сравнить top-N набор соседей и латентность. Метрики: overlap@finalTopN между комбинациями, прирост уникальных соседей от G/F, сдвиг top-1, добавленная латентность каждого канала. Это A/B «эффективности NES с расширениями» без IDE.
- **Диагностическая channel-inspection** (идея из dhi `/search` с режимами vector/bm25/hybrid; здесь — dev-only, не runtime-фича и не RPC). Встроить в харнесс функцию `inspectChannels(query, signals)`, печатающую для одного запроса топ каждого канала по отдельности (`S` / `G` / `F`) и итог `merged` с RRF-скорами — чтобы видеть, какой канал что внёс, и тюнить пороги (`ambiguityMargin`, fuzzy `threshold`, лимиты графа). Работает и для кода, и для прозы (для прозы G/F пустые — наглядно показывает no-op). Никакого пользовательского эндпоинта не добавляем — только диагностика в тестовом харнессе.

### 11.3 Что проверяют приёмочно

- `graph.enabled=false && fuzzy.enabled=false` → поведение байт-в-байт = текущему (только канал S, как сейчас).
- **Проза (typst/markdown/latex/plaintext) → только канал S**, даже при включённых G/F (универсальность NES сохранена; качество прозовых подсказок не меняется).
- Включение G/F не ломает FIM/Zeta (они не используют оркестратор).
- Сборка `npm run build` проходит, `npm test` зелёный, грамматики Nix/Nim грузятся, нативный `better-sqlite3` пересобран под Electron.

---

## 12. Конфигурация (итог)

```ts
'smart-completions.nes.graph.enabled': false      // канал CodeGraph
'smart-completions.nes.fuzzy.enabled': false      // канал Fuzzy
// rerank.* — как есть, но llamaUrl → http://127.0.0.1:8030/v1 (порт reranker'а)
```
Всё дефолт-on. Включать все.

---

## 13. Чек-лист внедрения (порядок)

1. Зависимости: `better-sqlite3` + `@types/better-sqlite3` + `fuzzysort`. В сборку приложения добавить пересборку нативного модуля под Electron (`@electron/rebuild`, §10.1). Поправить дефолтный порт reranker'а 8040→8030.
2. SQLite-слой: `sweep-graph-store.ts` (интерфейс + `BetterSqlite3GraphStore`, WAL, транзакции) + тест round-trip (переоткрытие файла).
3. tree-sitter loader (sweep-локальный) + `sweep-language-registry` (с nix/nim) + резолвер WASM.
4. Грамматики Nix/Nim: собрать совместимым CLI (§9), проверить загрузку, положить в `resources/grammars/`, закоммитить.
5. Экстрактор + индексатор + персистентность + тест экстрактора (вкл. Nix/Nim).
6. Каналы G и F (+ инкрементальные `updateFile`/`removeFile` в fuzzy) + тесты.
7. `merge.ts` + тест.
8. Оркестратор: перенести rerank-логику из backend, собрать S+G+F→merge→rerank + тест.
9. Интеграция в `retrieveNeighbors` (делегирование оркестратору, проброс `fileMode`), конфиг (`graph`/`fuzzy` в SweepConfig+NesConfig+readNesConfig), preferences, DI.
10. Lifecycle графа: RPC `configure`/`reindexFile(uri, source?, languageId?)`; в `config-sync.ts` — configure + диск-watch **только для не-открытых** файлов; новый `SweepGraphLiveRecorder` (browser) для живых правок открытых редакторов (дебаунс, откат при закрытии).
11. Интеграционные тесты , замеры, тюнинг `ambiguityMargin`/порогов fuzzy/`SWEEP_GRAPH_LIVE_DEBOUNCE_MS`.
12. `npm run build` + `npm test`; убедиться, что выключенные каналы дают прежнее поведение.

---

## 14. Риски и границы

- **ABI грамматик** — главный риск; строго собирать Nix/Nim CLI под ABI web-tree-sitter 0.20.8 и проверять загрузку. Иначе `Language.load` падает.
- **Маржинальная ценность убывает.** Вектор+BM25 уже многое покрывают; CodeGraph частично пересекается с LSP-hierarchy (ценность — offline/Nix/Nim/batch); Fuzzy самый узкий. Поэтому флаги и замеры по одному, а не всё разом.
- **Нативная сборка better-sqlite3** — нужно, чтобы сборка приложения пересобирала модуль под ABI Electron (`@electron/rebuild`, §10.1); иначе `NODE_MODULE_VERSION mismatch` при загрузке. Это разовый build-time шаг (как у текущих нативных зависимостей), пользователю не виден.
- **Автономность.** Sweep-граф полностью внутри модуля Sweep (свой loader, свой индексатор, своя БД, свой кэш-каталог). Никакой зависимости от внутренностей embedding-module; общий слой не трогается.
- **Живой граф — стоимость и гонки.** Живые обновления по набору обязательно дебаунсить (`SWEEP_GRAPH_LIVE_DEBOUNCE_MS` ~400ms) и обновлять fuzzy-каталог инкрементально (`updateFile`, без полного rebuild) — иначе на больших репо набор станет дорогим. Открытыми файлами владеет живой рекордер; диск-watch для них **пропускается**, чтобы устаревший диск не затирал dirty. Только-код трекаем (проза → no-op). WAL у better-sqlite3 хорошо держит частые мелкие записи.
- **Осознанный скос свежести.** Граф dirty-aware, вектор save-driven (эмбеддинги дороги для live-обновления). Каналы имеют разную свежесть — это by design, не баг: граф даёт live-структуру, вектор — семантику по стабильному корпусу. Вектор-индекс на dirty НЕ переводим (вне границ; дорого).
- **FIM/Zeta — легаси, не трогаем** до доведения Sweep до production, как и оговорено.
