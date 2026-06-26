# Спецификация: Producers-only рефакторинг (Composite) для Sweep

Версия под текущий код (commit `571b826`, после удаления output channels). Цель: вынести **только слой producers** под два единых Composite-интерфейса, чтобы добавление новых источников/каналов было «реализовать + зарегистрировать», без правок Transform-стадий и Layout.

- **Семейство 1 — фронт-источники related** → интерфейс `RelatedSource`, Composite в `SweepContextCollector`.
- **Семейство 2 — бэкенд-каналы retrieval** → интерфейс `RetrievalChannel`, Composite в `SweepRetrievalOrchestrator`.

**Ключевой инвариант: поведение не меняется.** Рефакторинг — чистое вынесение. Выход (`relatedFiles`, `neighbors`, итоговый промпт) должен остаться байт-в-байт.

---

## 0. Скоуп и инварианты

### Что меняется
- Вводятся два интерфейса-токена: `RelatedSource`, `RetrievalChannel`.
- Три фронт-источника (`Hierarchy/Search/Scm`) реализуют `RelatedSource`.
- Три адаптера-канала (`Semantic/Graph/Fuzzy`) реализуют `RetrievalChannel`, оборачивая существующие `EmbeddingIndexServiceImpl` / `SweepGraphChannel` / `SweepFuzzyChannel`.
- Коллектор и оркестратор перестают хардкодить последовательность вызовов и обходят зарегистрированный список (`@multiInject`).

### Что НЕ трогается (границы)
- **Transform-стадии:** `dedupeRankRelated`, `mergeNeighborChannels`, reranker, `dedupeContextFiles`, `trimSweepContext` — логика и сигнатуры без изменений.
- **Layout:** `buildSweepSections`, порядок секций промпта, спина (триада) — без изменений.
- **Существующие классы каналов** `SweepGraphChannel` / `SweepFuzzyChannel` и общий `EmbeddingIndexServiceImpl` — внутренности и сигнатуры `retrieve(...)` не меняются (поэтому их юнит-тесты остаются валидными). Их оборачивают адаптеры.
- `SymbolSource` (даёт outline, не related) — **не** `RelatedSource`, остаётся в коллекторе как есть.
- FIM/Zeta — без изменений.

### Два критических риска по поведению (главное)
Порядок регистрации = поведение, потому что в обоих семействах он определяет **tie-break** при равных score:

1. **Related:** `dedupeRankRelated` сортирует по `score`, а при равенстве — по `a.index - b.index`, где index = порядок добавления кандидатов. Сейчас это `hierarchy → search → scm`. Список регистрации `RelatedSource` **обязан** совпадать.
2. **Channels:** `mergeNeighborChannels` использует стабильную сортировку по RRF-score; при равном score выигрывает сосед из **более раннего** канала. Сейчас порядок `semantic → graph → fuzzy`. Список регистрации `RetrievalChannel` **обязан** совпадать.

Эти два порядка пинятся порядком `bind(...).toService(...)` в DI и закрываются golden-тестами (Часть C).

### Почему адаптеры для каналов, но прямая реализация для источников
- **Каналы:** `Semantic` оборачивает **общий** `EmbeddingIndexServiceImpl` (его трогать нельзя), а `Graph`/`Fuzzy` имеют юнит-тесты на текущую сигнатуру `retrieve(signals|symbols, topN)`. Адаптеры сохраняют и общий сервис, и эти тесты нетронутыми.
- **Источники:** `Hierarchy/Search/Scm` — sweep-локальные, прямых юнит-тестов на их `collect(...)` нет (зависят от Theia-runtime), поэтому смена сигнатуры на `collect(ctx)` безопасна и убирает лишнюю индирекцию.

---

## ЧАСТЬ A — Composite фронт-источников (`RelatedSource`)

### A.1 Новый файл: `src/browser/sweep/data-gathering-layer/sources/related-source.ts`

```ts
import URI from '@theia/core/lib/common/uri';
import { RelatedCandidate } from '../../../../common/sweep/related-files';

/** Контекст одного прохода сбора related-кандидатов; несёт всё, что нужно любому источнику. */
export interface RelatedSourceContext {
    languageId: string;
    uri: URI;
    position: { line: number; character: number };
    currentRelPath: string;
    queries: string[];
}

/** Источник related-кандидатов для Sweep file-блоков; собирается в композит SweepContextCollector. */
export interface RelatedSource {
    /** Стабильный id для логов/диагностики и метки safeAsync. */
    readonly id: string;
    /** Возвращает кандидатов; ошибки изолируются композитом (safeAsync), сам источник может бросать. */
    collect(ctx: RelatedSourceContext): Promise<RelatedCandidate[]>;
}

/** DI-токен для @multiInject; порядок биндингов = порядок tie-break в dedupeRankRelated. */
export const RelatedSource = Symbol('RelatedSource');
```

> `export const RelatedSource` (значение-токен) и `export interface RelatedSource` (тип) сосуществуют через declaration merging — стандартный inversify-паттерн.

### A.2 `sources/hierarchy-source.ts` — реализовать интерфейс

Сменить сигнатуру `collect` на `collect(ctx)` и добавить `id`. Тело не меняется — только распаковка из `ctx`.

```ts
// БЫЛО:
@injectable()
export class HierarchyRelatedSource {
    // ...inject...
    async collect(languageId: string, uri: URI, position: { line: number; character: number }, currentRelPath: string): Promise<RelatedCandidate[]> {
        const candidates: RelatedCandidate[] = [];
        await this.collectCallers(languageId, uri, position, currentRelPath, candidates);
        await this.collectTypes(languageId, uri, position, currentRelPath, candidates);
        LOG.info('Sweep hierarchy candidates collected', { languageId, candidates: candidates.length });
        return candidates;
    }

// СТАНЕТ:
@injectable()
export class HierarchyRelatedSource implements RelatedSource {
    readonly id = 'hierarchy';
    // ...inject (без изменений)...
    async collect(ctx: RelatedSourceContext): Promise<RelatedCandidate[]> {
        const { languageId, uri, position, currentRelPath } = ctx;
        const candidates: RelatedCandidate[] = [];
        await this.collectCallers(languageId, uri, position, currentRelPath, candidates);
        await this.collectTypes(languageId, uri, position, currentRelPath, candidates);
        LOG.info('Sweep hierarchy candidates collected', { languageId, candidates: candidates.length });
        return candidates;
    }
```

Добавить импорт в шапку файла:
```ts
import { RelatedSource, RelatedSourceContext } from './related-source';
```
Приватные методы `collectCallers/collectTypes/pushItem` — **без изменений**.

### A.3 `sources/search-source.ts` — реализовать интерфейс

```ts
// БЫЛО:
export class SearchRelatedSource {
    // ...
    async collect(queries: string[], currentRelPath: string): Promise<RelatedCandidate[]> {
        const candidates: RelatedCandidate[] = [];
        for (let i = 0; i < queries.length && i < MAX_QUERIES; i++) {
            // ...тело без изменений, использует queries[i] и currentRelPath...

// СТАНЕТ:
export class SearchRelatedSource implements RelatedSource {
    readonly id = 'search';
    // ...
    async collect(ctx: RelatedSourceContext): Promise<RelatedCandidate[]> {
        const { queries, currentRelPath } = ctx;
        const candidates: RelatedCandidate[] = [];
        for (let i = 0; i < queries.length && i < MAX_QUERIES; i++) {
            // ...тело идентично...
```
Импорт `import { RelatedSource, RelatedSourceContext } from './related-source';`. Приватный `runSearch` — без изменений.

### A.4 `sources/scm-source.ts` — реализовать интерфейс

```ts
// БЫЛО:
export class ScmChangedFilesSource {
    async collect(currentRelPath: string): Promise<RelatedCandidate[]> {
        // ...использует currentRelPath...

// СТАНЕТ:
export class ScmChangedFilesSource implements RelatedSource {
    readonly id = 'scm';
    async collect(ctx: RelatedSourceContext): Promise<RelatedCandidate[]> {
        const { currentRelPath } = ctx;
        // ...тело идентично...
```
Импорт `import { RelatedSource, RelatedSourceContext } from './related-source';`.

### A.5 `sweep-context-collector.ts` — композит вместо хардкода

Цель: заменить три отдельных `safeAsync(...)`-вызова и `pushAll` на цикл по `this.relatedSources`. Порядок массива = порядок биндинга = `hierarchy, search, scm`. `safeAsync` и изоляция ошибок сохраняются (метка = `src.id`). Логи остаются эквивалентными.

**(a) Импорты:** убрать прямые импорты трёх источников, добавить `RelatedSource`/контекст и `multiInject`:

```ts
// БЫЛО (строки 1, 11–13):
import { inject, injectable } from '@theia/core/shared/inversify';
// ...
import { HierarchyRelatedSource } from './sources/hierarchy-source';
import { ScmChangedFilesSource } from './sources/scm-source';
import { SearchRelatedSource } from './sources/search-source';

// СТАНЕТ:
import { inject, injectable, multiInject } from '@theia/core/shared/inversify';
// ...
import { RelatedSource, RelatedSourceContext } from './sources/related-source';
```
`SymbolSource` и `WorkspaceFiles` импорты — **оставить**.

**(b) Поля инъекции:** заменить три `@inject(...Source)` на один `@multiInject(RelatedSource)`:

```ts
// БЫЛО (строки 44–49):
    // Поиск по воркспейсу для нахождения файлов с похожими символами.
    @inject(SearchRelatedSource) protected readonly searchSource!: SearchRelatedSource;
    // Call/type hierarchy LSP для нахождения файлов-вызывателей и типов-родителей.
    @inject(HierarchyRelatedSource) protected readonly hierarchySource!: HierarchyRelatedSource;
    // SCM dirty-файлы как низкоприоритетный сигнал о co-changed зависимостях.
    @inject(ScmChangedFilesSource) protected readonly scmSource!: ScmChangedFilesSource;

// СТАНЕТ:
    // Все related-источники в порядке регистрации (= порядок tie-break в dedupeRankRelated): hierarchy, search, scm.
    @multiInject(RelatedSource) protected readonly relatedSources!: RelatedSource[];
```
`@inject(SymbolSource)` и `@inject(WorkspaceFiles)` — **оставить**.

**(c) Тело `collect()`:** заменить блок сбора (строки 76–95) на цикл по композиту. `currentRel`, `outline`, `queries` — без изменений.

```ts
// БЫЛО (строки 76–95):
        const fromHierarchy = await this.safeAsync(
            () => this.hierarchySource.collect(params.languageId, uri, lspPosition, currentRel),
            [] as RelatedCandidate[],
            'hierarchy',
        );
        const fromSearch = await this.safeAsync(() => this.searchSource.collect(queries, currentRel), [] as RelatedCandidate[], 'search');
        const fromScm = await this.safeAsync(() => this.scmSource.collect(currentRel), [] as RelatedCandidate[], 'scm');

        const relatedCandidates: RelatedCandidate[] = [];
        pushAll(relatedCandidates, fromHierarchy);
        pushAll(relatedCandidates, fromSearch);
        pushAll(relatedCandidates, fromScm);
        const relatedFiles = dedupeRankRelated(relatedCandidates, params.relatedTopN);

        LOG.info('Sweep context collected', {
            currentRel,
            queries: queries.length,
            hierarchyCandidates: fromHierarchy.length,
            searchCandidates: fromSearch.length,
            scmCandidates: fromScm.length,
            relatedFiles: relatedFiles.length,
            hasOutline: Boolean(outline),
            diagnostics: params.diagnostics.length,
        });

// СТАНЕТ:
        const sourceCtx: RelatedSourceContext = {
            languageId: params.languageId,
            uri,
            position: lspPosition,
            currentRelPath: currentRel,
            queries,
        };

        // Композит: обходим источники в порядке регистрации; каждый изолирован safeAsync по своему id.
        const relatedCandidates: RelatedCandidate[] = [];
        const perSource: Record<string, number> = {};
        for (const source of this.relatedSources) {
            const produced = await this.safeAsync(() => source.collect(sourceCtx), [] as RelatedCandidate[], source.id);
            perSource[source.id] = produced.length;
            pushAll(relatedCandidates, produced);
        }
        const relatedFiles = dedupeRankRelated(relatedCandidates, params.relatedTopN);

        LOG.info('Sweep context collected', {
            currentRel,
            queries: queries.length,
            perSource,
            relatedFiles: relatedFiles.length,
            hasOutline: Boolean(outline),
            diagnostics: params.diagnostics.length,
        });
```

> Порядок `pushAll` сохраняется ровно потому, что `this.relatedSources` забиндены в порядке `hierarchy, search, scm`. `pushAll`, `safe`, `safeAsync` — без изменений. `RelatedCandidate` импорт остаётся (используется в типе массива и fallback).

### A.6 DI: `src/browser/smart-completions-frontend-module.ts`

Привязать каждый источник к токену `RelatedSource` **в порядке** hierarchy → search → scm (этот порядок и есть поведение).

```ts
// Добавить импорт:
import { RelatedSource } from './sweep/data-gathering-layer/sources/related-source';

// БЫЛО (строки 43–48):
    bind(WorkspaceFiles).toSelf().inSingletonScope();
    bind(SymbolSource).toSelf().inSingletonScope();
    bind(SearchRelatedSource).toSelf().inSingletonScope();
    bind(HierarchyRelatedSource).toSelf().inSingletonScope();
    bind(ScmChangedFilesSource).toSelf().inSingletonScope();
    bind(SweepContextCollector).toSelf().inSingletonScope();

// СТАНЕТ (порядок toService = порядок tie-break):
    bind(WorkspaceFiles).toSelf().inSingletonScope();
    bind(SymbolSource).toSelf().inSingletonScope();

    bind(HierarchyRelatedSource).toSelf().inSingletonScope();
    bind(RelatedSource).toService(HierarchyRelatedSource);
    bind(SearchRelatedSource).toSelf().inSingletonScope();
    bind(RelatedSource).toService(SearchRelatedSource);
    bind(ScmChangedFilesSource).toSelf().inSingletonScope();
    bind(RelatedSource).toService(ScmChangedFilesSource);

    bind(SweepContextCollector).toSelf().inSingletonScope();
```

> Порядок `toService` критичен: `@multiInject` возвращает массив в порядке биндингов. `hierarchy, search, scm` = текущий порядок `pushAll`.

---

## ЧАСТЬ B — Composite бэкенд-каналов (`RetrievalChannel`)

### B.1 Новый файл: `src/node/sweep/retrieval/retrieval-channel.ts`

```ts
import type { Neighbor } from '../../../common/embedding-types';
import type { GraphQuerySignals } from '../../../common/sweep/types';
import type { SweepRetrievalConfig } from './sweep-retrieval-orchestrator';

/** Единый вход для всех каналов; каждый канал берёт нужные ему поля. */
export interface RetrievalChannelInput {
    query: string;
    signals: GraphQuerySignals;
    fuzzySymbols: string[];
    signal?: AbortSignal;
}

/** Канал retrieval; собирается в композит SweepRetrievalOrchestrator. */
export interface RetrievalChannel {
    /** Стабильный id для логов и диагностики. */
    readonly id: string;
    /** true → канал работает только для code mode (граф/fuzzy); false → и для прозы (semantic). */
    readonly codeOnly: boolean;
    /** Включён ли канал по конфигу (semantic — всегда; graph/fuzzy — по флагу). */
    isEnabled(config: SweepRetrievalConfig): boolean;
    /** Возвращает соседей; sync или async — оркестратор делает await в любом случае. */
    retrieve(input: RetrievalChannelInput, topN: number): Promise<Neighbor[]> | Neighbor[];
}

/** DI-токен для @multiInject; порядок биндингов = порядок tie-break в mergeNeighborChannels. */
export const RetrievalChannel = Symbol('RetrievalChannel');
```

### B.2 Новый файл: `src/node/sweep/retrieval/channels/semantic-retrieval-channel.ts`

Оборачивает общий `EmbeddingIndexServiceImpl`. Воспроизводит текущий `retrieveSemantic` (включая логи) **дословно**.

```ts
import { injectable } from '@theia/core/shared/inversify';
import type { Neighbor } from '../../../../common/embedding-types';
import { SweepLogger } from '../../../../common/sweep/logger';
import { EmbeddingIndexServiceImpl } from '../../../services/embedding-index-service';
import type { RetrievalChannel, RetrievalChannelInput } from '../retrieval-channel';
import type { SweepRetrievalConfig } from '../sweep-retrieval-orchestrator';

const LOG = new SweepLogger('node:retrieval-orchestrator');

/** Семантический канал S: LanceDB + BM25 → RRF через общий EmbeddingIndexServiceImpl (не модифицируем). */
@injectable()
export class SemanticRetrievalChannel implements RetrievalChannel {
    readonly id = 'semantic';
    readonly codeOnly = false;                 // работает и для прозы
    private readonly embedding: EmbeddingIndexServiceImpl;

    constructor(embedding: EmbeddingIndexServiceImpl) {
        this.embedding = embedding;
    }

    isEnabled(): boolean {
        return true;                           // S всегда активен (флага отключения нет — как сейчас)
    }

    async retrieve(input: RetrievalChannelInput, topN: number): Promise<Neighbor[]> {
        LOG.info('Sweep semantic retrieval starting', { queryChars: input.query.length, topN });
        const neighbors = await this.embedding.retrieve(input.query, topN, input.signal);
        const files = new Array<string>(neighbors.length);
        for (let i = 0; i < neighbors.length; i++) {
            files[i] = neighbors[i].filePath;
        }
        LOG.info('Sweep semantic retrieval completed', { neighbors: neighbors.length, files });
        return neighbors;
    }
}
```

### B.3 Новый файл: `src/node/sweep/retrieval/channels/graph-retrieval-channel.ts`

```ts
import { injectable } from '@theia/core/shared/inversify';
import type { Neighbor } from '../../../../common/embedding-types';
import { SweepGraphChannel } from '../graph/sweep-graph-channel';
import type { RetrievalChannel, RetrievalChannelInput } from '../retrieval-channel';
import type { SweepRetrievalConfig } from '../sweep-retrieval-orchestrator';

/** Структурный канал G поверх существующего SweepGraphChannel (его сигнатуру не меняем). */
@injectable()
export class GraphRetrievalChannel implements RetrievalChannel {
    readonly id = 'graph';
    readonly codeOnly = true;
    private readonly graph: SweepGraphChannel;

    constructor(graph: SweepGraphChannel) {
        this.graph = graph;
    }

    isEnabled(config: SweepRetrievalConfig): boolean {
        return config.graph.enabled;
    }

    retrieve(input: RetrievalChannelInput, topN: number): Neighbor[] {
        return this.graph.retrieve(input.signals, topN);
    }
}
```

### B.4 Новый файл: `src/node/sweep/retrieval/channels/fuzzy-retrieval-channel.ts`

```ts
import { injectable } from '@theia/core/shared/inversify';
import type { Neighbor } from '../../../../common/embedding-types';
import { SweepFuzzyChannel } from '../fuzzy/sweep-fuzzy-channel';
import type { RetrievalChannel, RetrievalChannelInput } from '../retrieval-channel';
import type { SweepRetrievalConfig } from '../sweep-retrieval-orchestrator';

/** Нечёткий канал F поверх существующего SweepFuzzyChannel (его сигнатуру не меняем). */
@injectable()
export class FuzzyRetrievalChannel implements RetrievalChannel {
    readonly id = 'fuzzy';
    readonly codeOnly = true;
    private readonly fuzzy: SweepFuzzyChannel;

    constructor(fuzzy: SweepFuzzyChannel) {
        this.fuzzy = fuzzy;
    }

    isEnabled(config: SweepRetrievalConfig): boolean {
        return config.fuzzy.enabled;
    }

    retrieve(input: RetrievalChannelInput, topN: number): Neighbor[] {
        return this.fuzzy.retrieve(input.fuzzySymbols, topN);
    }
}
```

### B.5 `sweep-retrieval-orchestrator.ts` — композит вместо хардкода

Цель: заменить три явных `channels.push(...)` на цикл по `this.channels`. merge/rerank/finalTopN/poolN — **без изменений**. `retrieveSemantic` уезжает в `SemanticRetrievalChannel` (B.2) и из оркестратора удаляется.

**(a) Импорты/конструктор:** убрать прямые поля `embedding/graph/fuzzy`, инжектить `RetrievalChannel[]`.

```ts
// БЫЛО:
import { injectable } from '@theia/core/shared/inversify';
// ...
import { EmbeddingIndexServiceImpl } from '../../services/embedding-index-service';
import { SweepFuzzyChannel } from './fuzzy/sweep-fuzzy-channel';
import { SweepGraphChannel } from './graph/sweep-graph-channel';
// ...
@injectable()
export class SweepRetrievalOrchestrator {
    private readonly reranker = new SweepRerankerClient();
    private rerankerBroken = false;
    private readonly embedding: EmbeddingIndexServiceImpl;
    private readonly graph: SweepGraphChannel;
    private readonly fuzzy: SweepFuzzyChannel;

    constructor(
        embedding: EmbeddingIndexServiceImpl,
        graph: SweepGraphChannel,
        fuzzy: SweepFuzzyChannel,
    ) {
        this.embedding = embedding;
        this.graph = graph;
        this.fuzzy = fuzzy;
    }

// СТАНЕТ:
import { injectable, multiInject } from '@theia/core/shared/inversify';
// ...
import { RetrievalChannel, RetrievalChannelInput } from './retrieval-channel';
// (импорты EmbeddingIndexServiceImpl / SweepFuzzyChannel / SweepGraphChannel здесь больше не нужны)
// ...
@injectable()
export class SweepRetrievalOrchestrator {
    private readonly reranker = new SweepRerankerClient();
    private rerankerBroken = false;
    private readonly channels: RetrievalChannel[];

    /** Каналы инжектятся в порядке регистрации (= порядок tie-break в merge): semantic, graph, fuzzy. */
    constructor(@multiInject(RetrievalChannel) channels: RetrievalChannel[]) {
        this.channels = channels;
    }
```

**(b) Метод `retrieve`:** заменить три `push` на цикл. Остальное (finalTopN, poolN, merged, rerank-гейт) без изменений.

```ts
// БЫЛО:
    async retrieve(input: OrchestratorInput, config: SweepRetrievalConfig): Promise<Neighbor[]> {
        const finalTopN = Math.max(1, Math.min(config.rerank.finalTopN, input.topN));
        const poolN = Math.max(finalTopN, config.rerank.candidatePoolN);
        const channels: Neighbor[][] = [];
        const semantic = await this.retrieveSemantic(input.query, poolN, input.signal);
        channels.push(semantic);
        if (input.fileMode === 'code' && config.graph.enabled) {
            channels.push(this.graph.retrieve(input.signals, poolN));
        }
        if (input.fileMode === 'code' && config.fuzzy.enabled) {
            channels.push(this.fuzzy.retrieve(input.fuzzySymbols, poolN));
        }
        const merged = mergeNeighborChannels(channels, poolN);
        if (!config.rerank.enabled || this.rerankerBroken || !isAmbiguous(merged, config.rerank.ambiguityMargin, finalTopN)) {
            return merged.slice(0, finalTopN);
        }
        try {
            return await this.rerankNeighbors(merged, input.query, config.rerank, finalTopN, input.signal);
        } catch (error) {
            LOG.warn('Sweep rerank failed, falling back to merged order', { error: error instanceof Error ? error.message : String(error) });
            return merged.slice(0, finalTopN);
        }
    }

// СТАНЕТ:
    async retrieve(input: OrchestratorInput, config: SweepRetrievalConfig): Promise<Neighbor[]> {
        const finalTopN = Math.max(1, Math.min(config.rerank.finalTopN, input.topN));
        const poolN = Math.max(finalTopN, config.rerank.candidatePoolN);
        const channelInput: RetrievalChannelInput = {
            query: input.query,
            signals: input.signals,
            fuzzySymbols: input.fuzzySymbols,
            signal: input.signal,
        };

        // Композит: обходим каналы в порядке регистрации; code-only пропускаются для прозы, флаг-гейтятся конфигом.
        const lists: Neighbor[][] = [];
        for (const channel of this.channels) {
            if (channel.codeOnly && input.fileMode !== 'code') {
                continue;
            }
            if (!channel.isEnabled(config)) {
                continue;
            }
            lists.push(await channel.retrieve(channelInput, poolN));
        }

        const merged = mergeNeighborChannels(lists, poolN);
        if (!config.rerank.enabled || this.rerankerBroken || !isAmbiguous(merged, config.rerank.ambiguityMargin, finalTopN)) {
            return merged.slice(0, finalTopN);
        }
        try {
            return await this.rerankNeighbors(merged, input.query, config.rerank, finalTopN, input.signal);
        } catch (error) {
            LOG.warn('Sweep rerank failed, falling back to merged order', { error: error instanceof Error ? error.message : String(error) });
            return merged.slice(0, finalTopN);
        }
    }
```

**(c) Удалить приватный `retrieveSemantic`** (переехал в `SemanticRetrievalChannel`). `rerankNeighbors`, `warmupReranker`, `configure`, `isAmbiguous`/`looksBroken`-вызовы — **без изменений**.

> Эквивалентность поведения: при списке `[semantic, graph, fuzzy]` цикл даёт ровно `S` (всегда, т.к. `codeOnly=false`, `isEnabled→true`) → `G` (если code && graph.enabled) → `F` (если code && fuzzy.enabled). Порядок в `lists` = порядок в старом коде → `mergeNeighborChannels` получает тот же вход → тот же выход.

### B.6 DI: `src/node/smart-completions-backend-module.ts`

Каналы биндятся к токену `RetrievalChannel` **в порядке** semantic → graph → fuzzy.

```ts
// Добавить импорты:
import { RetrievalChannel } from './sweep/retrieval/retrieval-channel';
import { SemanticRetrievalChannel } from './sweep/retrieval/channels/semantic-retrieval-channel';
import { GraphRetrievalChannel } from './sweep/retrieval/channels/graph-retrieval-channel';
import { FuzzyRetrievalChannel } from './sweep/retrieval/channels/fuzzy-retrieval-channel';

// БЫЛО (строки 37–40):
    bind(SweepFuzzyChannel).toSelf().inSingletonScope();
    bind(SweepGraphIndexer).toSelf().inSingletonScope();
    bind(SweepGraphChannel).toSelf().inSingletonScope();
    bind(SweepRetrievalOrchestrator).toSelf().inSingletonScope();

// СТАНЕТ (порядок toService = semantic, graph, fuzzy):
    bind(SweepFuzzyChannel).toSelf().inSingletonScope();
    bind(SweepGraphIndexer).toSelf().inSingletonScope();
    bind(SweepGraphChannel).toSelf().inSingletonScope();

    bind(SemanticRetrievalChannel).toSelf().inSingletonScope();
    bind(RetrievalChannel).toService(SemanticRetrievalChannel);
    bind(GraphRetrievalChannel).toSelf().inSingletonScope();
    bind(RetrievalChannel).toService(GraphRetrievalChannel);
    bind(FuzzyRetrievalChannel).toSelf().inSingletonScope();
    bind(RetrievalChannel).toService(FuzzyRetrievalChannel);

    bind(SweepRetrievalOrchestrator).toSelf().inSingletonScope();
```

> `EmbeddingIndexServiceImpl` уже забиндена `toSelf()` (строка 42) — `SemanticRetrievalChannel` её получит конструктором. `SweepGraphChannel`/`SweepFuzzyChannel` уже забиндены — адаптеры их получат.

---

## ЧАСТЬ C — Тесты

Раннер прежний: `npm test`. Стиль повторяет `sweep-orchestrator.test.ts`/`sweep-merge.test.ts`. Все тесты — без серверов и без Theia (мокаем источники/каналы как простые объекты, реализующие интерфейс).

### C.1 `test/sweep-related-composite.test.ts` — Composite источников + tie-break

Главный гард: при равных score выживает кандидат из **более раннего** источника. Плюс изоляция ошибок.

Так как `SweepContextCollector` завязан на Theia (`monaco`, `WorkspaceFiles`), тестируем **композитную логику отдельно**: маленький хелпер, повторяющий цикл коллектора над списком `RelatedSource`, → `dedupeRankRelated`. Чтобы не дублировать, выносим цикл в чистую функцию.

**Рефактор-вынос (в `sweep-context-collector.ts`)** — чистая экспортируемая функция, которую зовёт и коллектор, и тест:

```ts
/** Чистый композит: обходит источники по порядку, изолирует ошибки, отдаёт плоский список кандидатов. */
export async function collectRelatedCandidates(
    sources: RelatedSource[],
    ctx: RelatedSourceContext,
    onError?: (id: string, error: unknown) => void,
): Promise<RelatedCandidate[]> {
    const out: RelatedCandidate[] = [];
    for (const source of sources) {
        try {
            pushAll(out, await source.collect(ctx));
        } catch (error) {
            onError?.(source.id, error);
        }
    }
    return out;
}
```
Коллектор тогда зовёт `collectRelatedCandidates(this.relatedSources, sourceCtx, (id, e) => LOG.warn(...))` вместо инлайн-цикла (поведение идентично, но теперь юнит-тестируемо без Theia).

**Тест:**

```ts
import assert from 'node:assert';
import { test } from 'node:test';
import { collectRelatedCandidates } from '../src/browser/sweep/data-gathering-layer/sweep-context-collector';
import { dedupeRankRelated, RelatedCandidate } from '../src/common/sweep/related-files';
import type { RelatedSource, RelatedSourceContext } from '../src/browser/sweep/data-gathering-layer/sources/related-source';

const CTX: RelatedSourceContext = { languageId: 'typescript', uri: undefined as never, position: { line: 0, character: 0 }, currentRelPath: 'cur.ts', queries: [] };
const src = (id: string, out: RelatedCandidate[]): RelatedSource => ({ id, collect: async () => out });

test('composite preserves source order so equal-score tie-break favors earlier source', async () => {
    // Один и тот же файл-фрагмент с равным score от двух источников; должен выжить экземпляр из первого.
    const hierarchy = src('hierarchy', [{ filePath: 'a.ts', content: 'from-hierarchy', startLine: 1, endLine: 5, score: 1 }]);
    const scm = src('scm', [{ filePath: 'a.ts', content: 'from-scm', startLine: 1, endLine: 5, score: 1 }]);
    const candidates = await collectRelatedCandidates([hierarchy, scm], CTX);
    const ranked = dedupeRankRelated(candidates, 5);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].content, 'from-hierarchy');   // из первого источника
});

test('composite isolates a throwing source and keeps others', async () => {
    const boom: RelatedSource = { id: 'boom', collect: async () => { throw new Error('x'); } };
    const ok = src('ok', [{ filePath: 'b.ts', content: 'kept', startLine: 1, endLine: 3, score: 2 }]);
    const seen: string[] = [];
    const candidates = await collectRelatedCandidates([boom, ok], CTX, id => seen.push(id));
    assert.deepEqual(seen, ['boom']);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].content, 'kept');
});

test('composite concatenates in registration order', async () => {
    const a = src('a', [{ filePath: 'x.ts', content: 'A', score: 1 }]);
    const b = src('b', [{ filePath: 'y.ts', content: 'B', score: 1 }]);
    const out = await collectRelatedCandidates([a, b], CTX);
    assert.deepEqual(out.map(c => c.content), ['A', 'B']);
});
```

### C.2 `test/sweep-channel-composite.test.ts` — Composite каналов + tie-break + гейты

Тестируем `SweepRetrievalOrchestrator` с мок-каналами. Проверяем: semantic всегда; graph/fuzzy гейтятся `codeOnly`+`isEnabled`; порядок в merge = порядок каналов; прозовый режим = только semantic.

```ts
import assert from 'node:assert';
import { test } from 'node:test';
import { SweepRetrievalOrchestrator } from '../src/node/sweep/retrieval/sweep-retrieval-orchestrator';
import type { RetrievalChannel } from '../src/node/sweep/retrieval/retrieval-channel';
import type { Neighbor } from '../src/common/embedding-types';

const N = (file: string, score = 1): Neighbor => ({ filePath: file, startLine: 1, endLine: 2, text: file, score });

function channel(id: string, codeOnly: boolean, enabled: boolean, out: Neighbor[]): RetrievalChannel {
    return { id, codeOnly, isEnabled: () => enabled, retrieve: () => out };
}

const RERANK_OFF = { rerank: { enabled: false, finalTopN: 10, candidatePoolN: 10 } as never, graph: { enabled: true }, fuzzy: { enabled: true } };
const INPUT = (fileMode: 'code' | 'prose') => ({ query: 'q', fileMode, signals: {} as never, fuzzySymbols: ['s'], topN: 10 });

test('semantic always runs; code mode includes graph and fuzzy in registration order', async () => {
    const orch = new SweepRetrievalOrchestrator([
        channel('semantic', false, true, [N('s.ts')]),
        channel('graph', true, true, [N('g.ts')]),
        channel('fuzzy', true, true, [N('f.ts')]),
    ]);
    const out = await orch.retrieve(INPUT('code'), RERANK_OFF);
    assert.deepEqual(out.map(n => n.filePath), ['s.ts', 'g.ts', 'f.ts']);  // merge сохранил порядок каналов
});

test('prose mode runs only non-code-only channels (semantic)', async () => {
    const orch = new SweepRetrievalOrchestrator([
        channel('semantic', false, true, [N('s.ts')]),
        channel('graph', true, true, [N('g.ts')]),
        channel('fuzzy', true, true, [N('f.ts')]),
    ]);
    const out = await orch.retrieve(INPUT('prose'), RERANK_OFF);
    assert.deepEqual(out.map(n => n.filePath), ['s.ts']);
});

test('disabled channel is skipped even in code mode', async () => {
    const orch = new SweepRetrievalOrchestrator([
        channel('semantic', false, true, [N('s.ts')]),
        channel('graph', true, false, [N('g.ts')]),   // graph.enabled=false
        channel('fuzzy', true, true, [N('f.ts')]),
    ]);
    const out = await orch.retrieve(INPUT('code'), RERANK_OFF);
    assert.deepEqual(out.map(n => n.filePath), ['s.ts', 'f.ts']);
});

test('equal-RRF tie-break favors earlier channel', async () => {
    // Один и тот же сосед (file:start:end) от semantic и graph → выживает один, скоры складываются;
    // важно, что merge не падает и порядок детерминирован.
    const dup = N('dup.ts');
    const orch = new SweepRetrievalOrchestrator([
        channel('semantic', false, true, [dup]),
        channel('graph', true, true, [dup]),
    ]);
    const out = await orch.retrieve(INPUT('code'), RERANK_OFF);
    assert.equal(out.length, 1);
    assert.equal(out[0].filePath, 'dup.ts');
});
```

### C.3 Обновить существующий `test/sweep-orchestrator.test.ts`

Текущий тест строит оркестратор с тремя позиционными зависимостями (`embedding, graph, fuzzy`). После смены конструктора на `@multiInject(RetrievalChannel) channels` — переписать конструирование на массив мок-каналов (как в C.2). Семантику тестов сохранить: «graph/fuzzy только для code mode», rerank-ambiguity, finalTopN. Это механическая адаптация под новый конструктор, не новая логика.

### C.4 Что тесты гарантируют

- **Tie-break по порядку источников** (C.1) и **по порядку каналов** (C.2) — единственный реальный риск скоупа закрыт.
- Изоляция ошибок источника сохранена (C.1).
- Гейтинг `codeOnly`/`isEnabled` эквивалентен старым `if (fileMode==='code' && cfg.X.enabled)` (C.2).
- merge/rerank/finalTopN не затронуты (C.2/C.3 проходят на прежней логике).

---

## ЧАСТЬ D — Проверка и приёмка

```bash
cd smart-completions
# 1. Сборка
npx tsc -b            # допустим только pre-existing варнинг moduleResolution=node10

# 2. Тесты
npx tsc -p test/tsconfig.json --ignoreDeprecations 6.0
node --test lib-test/test/*.test.js
#   → 0 fail; новые composite-тесты зелёные; обновлённый orchestrator-тест зелёный

# 3. Существующие тесты каналов не изменились и проходят
node --test lib-test/test/sweep-graph-*.test.js lib-test/test/sweep-fuzzy-channel.test.js lib-test/test/sweep-merge.test.js
```

### Критерии приёмки

- `tsc -b` без новых ошибок; `node --test` — 0 fail.
- **Порядок биндингов** `RelatedSource` = `hierarchy, search, scm`; `RetrievalChannel` = `semantic, graph, fuzzy`. (Проверяется tie-break тестами.)
- `dedupeRankRelated`, `mergeNeighborChannels`, reranker, `dedupeContextFiles`, `trimSweepContext`, `buildSweepSections` — **не изменены** (`git diff` по ним пустой).
- `SweepGraphChannel` / `SweepFuzzyChannel` / `EmbeddingIndexServiceImpl` — внутренности и сигнатуры `retrieve(...)` **не изменены**; их юнит-тесты не правились и проходят.
- `SymbolSource`/outline-ветка коллектора — не изменена.
- FIM/Zeta — не тронуты.

---

## ЧАСТЬ E — Порядок внедрения (коммиты)

Делать маленькими шагами, каждый — зелёная сборка и тесты:

1. **Интерфейсы** (`related-source.ts`, `retrieval-channel.ts`) — только типы/токены. Сборка зелёная (ещё никем не используются).
2. **Адаптеры каналов** (`semantic/graph/fuzzy-retrieval-channel.ts`) — новые файлы, ещё не забинженные.
3. **Источники реализуют `RelatedSource`** (A.2–A.4) + DI (A.6). Коллектор пока по-старому, но источники уже годны.
4. **Коллектор → композит** (A.5) + вынос `collectRelatedCandidates` + тест C.1.
5. **Оркестратор → композит** (B.5) + DI каналов (B.6) + тест C.2 + адаптация C.3.
6. **Финальная проверка** (Часть D), `git diff` по Transform/Layout пустой.

---

## ЧАСТЬ F — Границы (явно не трогаем)

- `dedupeRankRelated` (внутренняя связка sort→dedup→cap) — без изменений; композит лишь формирует ему вход в том же порядке.
- `mergeNeighborChannels`, reranker, `dedupeContextFiles`, `trimSweepContext` — без изменений.
- `buildSweepSections` и порядок секций промпта, спина (триада) — без изменений.
- `SweepGraphChannel`/`SweepFuzzyChannel`/`EmbeddingIndexServiceImpl` — оборачиваются, не модифицируются.
- `SymbolSource` (outline) — не `RelatedSource`, без изменений.
- FIM, Zeta, embedding-индекс, LanceDB — без изменений.