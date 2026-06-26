# Спецификация (Часть 2): lru-cache, Reranker, Diagnostics-delta gate

Продолжение `codegraph-fuzzy-integration-spec.md`. Добавляет три интеграции в модуль Sweep NES: **lru-cache** (перф), **reranker через llama.cpp `/rerank`** (качество retrieval), **diagnostics-delta gate** (качество правок). Нумерация частей продолжается (E, F, G). Граница та же: только Sweep, FIM/Zeta не трогаем.

Приоритет внедрения: **E (lru-cache) → F (reranker) → G (diagnostics-gate)**. E — самый дешёвый и безопасный перф-выигрыш; G — самый дорогой и ситуативный (по умолчанию off).

---

# ЧАСТЬ E — lru-cache (перф горячего пути)

## E.1 Где реально помогает (привязка к коду)

Не «кешировать всё подряд», а две точки, где на каждый predict повторяется дорогая работа:

1. **tree-sitter parse в syntax-гейте.** `SweepSyntaxGate.errorDelta` (`src/node/sweep/model-call-layer/syntax-gate.ts`) парсит **два** окна (old и new) на каждый code-predict. `old`-окно при движении курсора в той же области часто идентично предыдущему вызову → парс old можно брать из кэша. Кэшируем `errorCount(source)` по хешу `(languageId, source)`.
2. **token-count в триммере.** `QwenTokenCounter.count(text)` (`token-counter.ts`) зовётся в `trimSweepContext` по каждому куску (broad file, neighbors, edits…). Broad-file и соседние чанки повторяются между predict'ами в одной области → кэшируем `count(text)` по хешу текста.

Что **не** кешировать (чтобы не плодить сложность без выигрыша):
- **prompt prefixes** — этим уже занимается llama.cpp `cache_prompt:true` (KV-cache на сервере). Клиентский кэш строк промпта не нужен.
- **file windows** — `editorBroadWindow`/`editorWindow` читают Monaco-модель в памяти, это дёшево.
- **diagnostics digest** — мелочь, форматирование строк; не окупает кэш.

## E.2 Зависимость и ключи

`package.json` → `dependencies`: `"lru-cache": "^11.x"` (pure-JS, оффлайн-безопасно). Хеш — существующий `md5` из `src/node/util/hash.ts`.

**Важный нюанс стоимости.** Ключ по `md5(text)` окупается только если хеширование дешевле повторной токенизации/парса И текст реально повторяется. Для крупных кусков (broad file, окна) md5 << токенизация Qwen — кэш выигрывает. Для мелких строк (`filePath`, 8-токенный оверхед) md5-оверхед не окупается, а токенизировать их и так дёшево. Поэтому кэш применяем **только к тексту длиннее порога** (`CACHE_MIN_CHARS ≈ 200`), ниже — считаем напрямую.

## E.3 Token-count cache

Обернуть счёт в `token-counter.ts` (только когда `mode === 'tokenizer'` — char-fallback и так O(n)):

```ts
import { LRUCache } from 'lru-cache';
import { md5 } from '../../util/hash';

const CACHE_MIN_CHARS = 200;

export class QwenTokenCounter implements TokenCounter {
    // ...существующее...
    private readonly countCache = new LRUCache<string, number>({ max: 2048 });

    count(text: string): number {
        if (!text) return 0;
        if (this.tokenizer === null) return charTokenEstimate(text); // fallback, без кэша
        if (text.length < CACHE_MIN_CHARS) return this.rawCount(text); // мелочь — без кэша
        const key = md5(text);
        const hit = this.countCache.get(key);
        if (hit !== undefined) return hit;
        const n = this.rawCount(text);
        this.countCache.set(key, n);
        return n;
    }

    private rawCount(text: string): number {
        try {
            const encoded = encodeWithTokenizer(this.tokenizer, text);
            return encoded >= 0 ? encoded : charTokenEstimate(text);
        } catch { return charTokenEstimate(text); }
    }
}
```

Кэш живёт на экземпляре `QwenTokenCounter` (singleton в backend) → переживает между predict'ами. Сбрасывать не нужно (контент-адресуемый: одинаковый текст → одинаковое число токенов).

## E.4 Tree-sitter errorCount cache

В `syntax-gate.ts` кэшировать результат `errorCount` по `(grammar, source)`:

```ts
private readonly errorCache = new LRUCache<string, number>({ max: 512 });

private errorCount(parser: Parser, grammar: string, source: string): number {
    const key = `${grammar}:${md5(source)}`;
    const hit = this.errorCache.get(key);
    if (hit !== undefined) return hit;
    const n = this.computeErrorCount(parser, source); // текущая walk-логика
    this.errorCache.set(key, n);
    return n;
}
```

При движении курсора в той же области `old`-окно повторяется → один из двух парсов берётся из кэша. `new`-окно меняется каждый раз (кэш-промах ожидаем — это нормально, мы экономим на `old`).

## E.5 Сочетание с llama.cpp prompt cache

Эти кэши — клиентские (parse/токены). Серверный `cache_prompt:true` (уже включён в `llama-sweep-client.ts`) кэширует KV промпта. Они **независимы и складываются**: клиент экономит на подготовке промпта, сервер — на его префиксе. Ничего менять в серверной части не нужно.

## E.6 Тесты и приёмка

- `count(text)` для длинного текста: второй вызов — кэш-хит (мокнуть токенайзер, проверить, что `rawCount` вызван один раз).
- `count` для текста < `CACHE_MIN_CHARS` — кэш не используется.
- `errorCount` для одинакового `(grammar, source)` — второй вызов из кэша.
- Приёмка: на серии predict'ов в одной области файла число вызовов токенайзера/парсера падает (видно по логам/профилю); поведение (числа) идентично без-кэшевому.

---

# ЧАСТЬ F — Reranker через llama.cpp `/rerank`

## F.1 Идея и место в пайплайне

Каналы S/G/F (Часть 1) дают пул кандидатов, слитый RRF. Reranker — **второй этап**: cross-encoder оценивает релевантность каждого кандидата запросу точнее, чем RRF по рангам. Поток (как ты и описывал):

```
retrieve больше кандидатов (pool 20-40) из каналов S+G+F → mergeNeighborChannels
   → дешёвый отсев (длина/путь/символ)
   → /rerank top 10-20 ТОЛЬКО при высокой неоднозначности
   → top 3-8 в промпт (→ dedup → trim)
```

Ключевое: финальный вклад в промпт (`finalTopN`) не растёт — reranker улучшает *порядок* топа, а не его размер (бюджет триады/recent edits не трогаем).

## F.2 Модель и сервер (модели уже скачаны)

Reranker-модели (Qwen3-Reranker, instruction-aware) **уже скачаны** — выбор/исследование/конвертация GGUF вне области этой спеки. Интеграция исходит из того, что модель отдаётся отдельным llama-server'ом (как у тебя модель-на-порт: embed/nes на своих портах, reranker — на своём, напр. **8040**) и `/rerank` уже работает. Со стороны плагина нужны только `baseUrl`, `model` (alias) и опциональная инструкция — всё через конфиг (F.9). Сервер reranker'а запускается с `--reranking --pooling rank` (это даёт endpoint `/rerank`); конкретная команда запуска — на твоей стороне.

**Единственная защита, которую плагин обязан держать на своей стороне** — runtime-страховка от неверно отдающего сервера/модели: если `/rerank` вернул вырожденные скоры (все ≈0 / |score| < 1e-10), это считается неисправной конфигурацией reranker'а, и плагин уходит в fail-open на RRF-порядок (`looksBroken`, F.7). Никаких предположений о происхождении GGUF плагин не делает — только реакция на вырожденный ответ.

## F.3 Endpoint `/rerank` (формат)

llama-server отдаёт `POST /v1/rerank` (старые сборки — только `/rerank`; запинить свежий llama.cpp). Формат:

Запрос:
```json
{ "model": "qwen3-reranker-0.6b", "query": "<query>", "top_n": 20, "documents": ["doc0", "doc1", "..."] }
```
Ответ (результаты в порядке ВХОДА — сортировать по `relevance_score` desc на клиенте):
```json
{ "results": [ { "index": 0, "relevance_score": 8.60 }, { "index": 1, "relevance_score": -5.38 } ], "usage": { "prompt_tokens": 51 } }
```

## F.4 Клиент

```ts
// src/node/sweep/retrieval/rerank/sweep-reranker-client.ts
export interface RerankResult { index: number; score: number; }
export class SweepRerankerClient {
    async rerank(input: { baseUrl: string; model: string; query: string; documents: string[]; topN: number; timeoutMs: number; signal?: AbortSignal }): Promise<RerankResult[]> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), input.timeoutMs);
        // связать с input.signal (отмена predict)
        try {
            const res = await fetch(`${trimUrl(input.baseUrl)}/rerank`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: input.model, query: input.query, top_n: input.topN, documents: input.documents }),
                signal: controller.signal,
            });
            if (!res.ok) throw new Error(`rerank ${res.status}`);
            const json = await res.json() as { results?: RerankResult[] };
            const results = (json.results ?? []).map(r => ({ index: r.index, score: (r as any).relevance_score ?? r.score }));
            return results.sort((a, b) => b.score - a.score);
        } finally { clearTimeout(timer); }
    }
}
```

## F.5 Инструкция Qwen3 (ключевая фишка)

Qwen3-Reranker принимает task-инструкцию, дающую 1–5% прироста. Для NES инструкция должна описывать задачу «оценить полезность чанка для предсказания следующей правки». Инструкция кладётся в начало `query` (Qwen3 rerank-template оборачивает query; точное место инъекции зависит от template сервера — проверить, что скоры с инструкцией лучше, чем без).

Дефолтная инструкция (англ., как советует Qwen — инструкции в train были на английском):
```
Instruct: Given the current code edit context and cursor location, rank code snippets by how useful they are for predicting the developer's next edit. Prioritize snippets defining or calling the symbols being edited.
```
Вынести в `sweep.rerank.instruction` (редактируемо). `query` для rerank = `instruction + "\n" + editSignalQuery` (тот же edit-signal запрос, что у retrieval, + при желании строка курсора).

`documents` = тексты кандидатов-`Neighbor`, каждый обрезан до `maxDocChars` (реранкеры имеют лимит контекста; длинные чанки резать).

## F.6 Адаптивный гейтинг (rerank только при неоднозначности)

Не дёргать reranker на каждый predict — round-trip дорог. Запускать, когда RRF-топ **неоднозначен**: малый отрыв скоров топ-кандидатов. Дешёвая эвристика:

```ts
function isAmbiguous(merged: Neighbor[], margin: number, finalTopN: number): boolean {
    if (merged.length <= finalTopN) return false;          // кандидатов не больше, чем нужно — ранжировать нечего
    const a = merged[finalTopN - 1]?.score ?? 0;           // последний «проходной»
    const b = merged[finalTopN]?.score ?? 0;               // первый «за бортом»
    return (a - b) < margin;                                // граница размыта → rerank решит
}
```
Если неоднозначно → rerank pool → topN; иначе берём merge-topN без rerank. Экономит латентность на лёгких случаях.

## F.7 Интеграция в оркестратор

Расширить `SweepRetrievalOrchestrator` (Часть 1, C.2):

```ts
async retrieve(input): Promise<Neighbor[]> {
    const channels = [/* S, G, F как в Части 1, но с poolN вместо finalTopN */];
    const merged = mergeNeighborChannels(channels, this.cfg.candidatePoolN);   // больше кандидатов
    if (!this.reranker || !isAmbiguous(merged, this.cfg.ambiguityMargin, this.cfg.finalTopN)) {
        return merged.slice(0, this.cfg.finalTopN);          // без rerank
    }
    const docs = merged.map(n => clip(n.text, this.cfg.maxDocChars));
    let ranked: RerankResult[];
    try {
        ranked = await this.reranker.rerank({ baseUrl: this.cfg.rerankUrl, model: this.cfg.rerankModel, query: this.buildRerankQuery(input), documents: docs, topN: this.cfg.rerankTopN, timeoutMs: this.cfg.rerankTimeoutMs, signal: input.signal });
        if (looksBroken(ranked)) throw new Error('reranker returned degenerate scores'); // 1e-20 → вырожденные скоры (F.2)
    } catch (e) {
        LOG.warn('Sweep rerank failed, falling back to RRF order', { error: String(e) });
        return merged.slice(0, this.cfg.finalTopN);          // FAIL-OPEN
    }
    return ranked.slice(0, this.cfg.finalTopN).map(r => merged[r.index]);
}
```

`looksBroken`: все скоры ≈0 или |score| < 1e-10 → неисправный reranker (F.2), отключить reranker до перезапуска.

## F.8 Fail-open и warmup (обязательно)

- **Fail-open.** Любая ошибка (сеть/таймаут/битые скоры/`/rerank` отсутствует на старой сборке) → вернуть pre-rerank RRF-порядок без изменений. Надёжность подсказки важнее качества ранжирования: если reranker-сервер упал, NES продолжает работать на RRF.
- **Warmup.** Первый вызов холодного reranker (особенно 4B на CPU) может занять 8–15 с. В `configure()` сделать прогревочный rerank (query + 1-2 dummy-документа) с большим таймаутом, чтобы первая реальная подсказка не словила таймаут и не ушла в fail-open молча.
- **Таймаут.** `sweep.rerank.timeoutMs` (дефолт ~1500 мс на горячем пути; warmup — отдельный большой таймаут). Превышение → fail-open.

## F.9 Конфигурация

```ts
'smart-completions.nes.rerank.enabled': false
'smart-completions.nes.rerank.llamaUrl': 'http://127.0.0.1:8040/v1'
'smart-completions.nes.rerank.model': 'qwen3-reranker-0.6b'
'smart-completions.nes.rerank.instruction': '<F.5 default>'
'smart-completions.nes.rerank.candidatePoolN': 24      // сколько тащить из каналов до rerank
'smart-completions.nes.rerank.rerankTopN': 16          // сколько отдать в /rerank
'smart-completions.nes.rerank.finalTopN': 8            // сколько в промпт (== текущий topN, НЕ растить)
'smart-completions.nes.rerank.ambiguityMargin': 0.02
'smart-completions.nes.rerank.timeoutMs': 1500
'smart-completions.nes.rerank.maxDocChars': 2000
```

Прокинуть в `SweepConfig` и `configure()`.

## F.10 Тесты и приёмка

- Клиент: мок `/rerank` → парсинг `results`, сортировка по `relevance_score`.
- `isAmbiguous`: чёткий топ → false (rerank не зовётся); размытый → true.
- Fail-open: мок ошибки/таймаута → возвращается merge-порядок; `looksBroken` на 1e-20 → fail-open.
- Приёмка: `rerank.enabled=false` → поведение идентично Части 1. `true` + неоднозначный пул → порядok кандидатов в промпте меняется по `relevance_score`; при падении reranker-сервера NES продолжает работать.

---

# ЧАСТЬ G — Diagnostics-delta verifier (post-apply, без shadow-модели)

## G.1 Переработка: убираем хрупкость

Прежний дизайн (pre-show gate на shadow-модели + ожидание LSP) хрупок по двум причинам: LSP может не анализировать невидимую временную модель, и ожидание маркеров добавляет латентность на горячий путь до показа. Обе проблемы устранены сменой подхода.

**Новый подход — два независимых, не-хрупких механизма с чётким разделением труда:**

1. **Pre-show (уже есть, ничего не добавляем):** дешёвый tree-sitter `SweepSyntaxGate` на backend отсекает **синтаксические** регрессии до показа. Это и есть быстрая преграда. Он надёжен и самодостаточен — никакого LSP не требует.
2. **Post-apply verifier (новое, надёжное):** **семантические/типовые** регрессии проверяются уже **на реальной модели** через **естественные** маркеры LSP, которые редактор и так считает для открытого документа. Никакой shadow-модели, никакого форсирования LSP, ноль латентности до показа.

Ключевая идея: не пытаться предсказать диагностику до показа (это и порождало хрупкость), а **верифицировать по факту** — после применения правки, используя тот анализ, который LSP делает сам по открытому документу. Это надёжно, потому что опирается на штатный цикл LSP, а не на принудительный анализ временной модели.

## G.2 Принцип работы

Верификатор живёт во фронтенде и срабатывает **после accept** (когда правка уже в реальной модели):

1. **В момент accept** (до применения правки) снять `beforeErrors` = число error-маркеров файла (`monaco.editor.getModelMarkers({ resource: uri })`, severity=Error). Запомнить `acceptVersion = model.getVersionId()`.
2. Применить правку (штатный `renderer.accept()`).
3. Подписаться **один раз** на `onDidChangeMarkers` для этого uri с таймаутом `settleTimeoutMs`. LSP сам переанализирует **реальный** изменённый документ (он это делает всегда) и обновит маркеры.
4. Когда маркеры пришли (и «устаканились» — см. G.4) или истёк таймаут:
   - `afterErrors` = число error-маркеров файла сейчас.
   - Если `afterErrors > beforeErrors` → правка **ввела** ошибки → действие по `mode` (G.3).
   - Иначе → ничего не делаем.
5. **Fail-open всегда:** нет маркеров / таймаут / LSP не отвечает → ничего не делаем (правка остаётся).

**Метрика — число error-маркеров по всему файлу**, а не по диапазону. Это убирает хрупкое «сдвигание диапазона» после правки (правка меняет число строк) и при этом корректно изолирует эффект именно этой правки: фоновые ошибки между «до» и «после» постоянны, меняет счётчик только применённая правка.

## G.3 Режим реакции: warn (дефолт) и revert

```ts
'mode': 'warn' | 'revert'
```

- **`warn` (по умолчанию, самый безопасный):** при регрессе — ненавязчивый сигнал (лог + опционально лёгкая нотификация «NES-правка добавила N диагностик»). Правку **не трогаем** — не воюем с пользователем. Для соло-разработки с проверкой «на опыте» это идеально: видишь провалы модели, не теряя контроль.
- **`revert` (опционально, с защитой):** при регрессе — откат правки **обратным edit** (не `undo`!), и только если документ не менялся с момента accept: `model.getVersionId() === acceptVersion`. Если пользователь успел что-то напечатать за время верификации (`versionId` изменился) — **откат отменяется** (fail-open), чтобы не стереть ввод пользователя. Это тот же version-guard, что уже используется в контроллере.

Почему обратный edit, а не `undo`: `undo` асинхронно мог бы откатить не ту операцию (если пользователь печатал). Обратный edit + version-guard безопасны и точны.

## G.4 Надёжность (почему не хрупко)

- **Реальная модель, не shadow** — LSP всегда анализирует открытый документ, поэтому маркеры гарантированно обновятся (в отличие от временной модели, которую LSP мог игнорировать).
- **Естественный цикл LSP** — мы не форсируем анализ, а слушаем `onDidChangeMarkers` (стабильный Monaco/Theia API).
- **Settle-дебаунс:** LSP может слать маркеры несколькими порциями. Ждём «тишины» `settleMs` (≈150 мс без новых событий) после первого изменения, либо общий `settleTimeoutMs` — затем одно сравнение, отписка.
- **Ноль латентности до показа/accept** — верификация целиком после применения, на горячий путь подсказки не влияет.
- **Version-guard** при `revert` — не конфликтует с вводом пользователя.
- **Fail-open** на каждом шаге — отсутствие/медленность LSP не ломает и не блокирует NES.

Единственный компромисс относительно «настоящего gate»: в режиме `revert` плохая правка кратко (сотни мс) присутствует в документе до отката — но с понятной причиной и без хрупкости. В режиме `warn` отката нет вовсе. Это осознанный размен надёжности на «правка не появляется ни на миг», и он правильный: pre-show синтаксис уже закрыт tree-sitter-гейтом, а типовые ошибки ловятся по факту надёжно.

## G.5 Интеграция (точки в коде)

Новый файл `src/browser/sweep/quality/diagnostics-delta-verifier.ts`:

```ts
@injectable()
export class DiagnosticsDeltaVerifier {
    /** Снять счётчик error-маркеров до правки; вызывается синхронно перед accept. */
    snapshotBefore(model: monaco.editor.ITextModel): { before: number; version: number } {
        return { before: countErrors(model.uri), version: model.getVersionId() };
    }
    /** После применённой правки дождаться устаканивания маркеров и отреагировать по mode. Полностью fail-open. */
    async verify(model: monaco.editor.ITextModel, snap: { before: number; version: number }, applied: TextEditDTO, cfg: DiagGateCfg): Promise<void> {
        const after = await this.settleErrors(model.uri, cfg.settleTimeoutMs, cfg.settleMs); // undefined при таймауте
        if (after === undefined || after <= snap.before) return;                              // нет регресса / нет данных → ничего
        if (cfg.mode === 'warn') { LOG.info('NES edit raised diagnostics', { before: snap.before, after }); /* + опц. notification */ return; }
        if (model.getVersionId() !== snap.version) return;                                     // пользователь печатал → не откатываем
        applyInverse(model, applied);                                                          // безопасный обратный edit
        LOG.info('NES edit reverted by diagnostics verifier', { before: snap.before, after });
    }
}
```

Вызов из `sweep-controller.ts` в момент accept (контроллер уже владеет accept-путём — `accept()`/`jumpOrAccept()` делегируют рендереру):

```ts
accept(): void {
    if (!this.config.diagnosticsGate.enabled || this.currentFileMode !== 'code') { this.renderer.accept(); return; }
    const model = /* активная модель */;
    const applied = /* edit, который применит renderer */;
    const snap = this.diagVerifier.snapshotBefore(model);
    this.renderer.accept();                                   // штатное применение
    void this.diagVerifier.verify(model, snap, applied, this.config.diagnosticsGate); // фоном, не блокирует
}
```

`countErrors(uri)` = `monaco.editor.getModelMarkers({ resource: uri }).filter(m => m.severity === MarkerSeverity.Error).length`. Никаких новых зависимостей.

## G.6 Конфигурация

```ts
'smart-completions.nes.diagnosticsGate.enabled': false
'smart-completions.nes.diagnosticsGate.mode': 'warn'          // 'warn' | 'revert'
'smart-completions.nes.diagnosticsGate.settleTimeoutMs': 800  // макс. ожидание маркеров после правки
'smart-completions.nes.diagnosticsGate.settleMs': 150         // «тишина» маркеров = LSP закончил
```

(`radiusLines` больше не нужен — метрика по всему файлу.)

## G.7 Тесты и приёмка

- `snapshotBefore` → `countErrors` корректно считает только severity=Error.
- `verify` в `warn`: мок `onDidChangeMarkers` с after > before → лог-предупреждение, правка не трогается.
- `verify` в `revert`: after > before и version неизменна → обратный edit применён; after > before, но version изменилась → отката нет (fail-open).
- Таймаут маркеров → ничего не делаем (fail-open).
- Приёмка: `enabled=false` → accept идентичен текущему. `warn`: правка с типовой ошибкой при живом LSP даёт предупреждение, не мешая. `revert`: такая правка откатывается, если пользователь не печатал; ввод пользователя никогда не теряется. Нет shadow-модели, нет латентности до показа.

## G.8 Чем это лучше прежнего дизайна

| | Было (shadow gate) | Стало (post-apply verifier) |
|---|---|---|
| Источник диагностики | временная модель (LSP мог игнорировать) | реальная модель (LSP всегда анализирует) |
| Латентность до показа | +300–500 мс | 0 |
| Хрупкость | высокая (анализ shadow не гарантирован) | низкая (штатный цикл LSP) |
| Риск для пользователя | — | нет (warn) / version-guard (revert) |
| Сложность интеграции | shadow create/dispose, marker-wait на временный uri | один listener на реальный uri + счётчик |

---

## Сводный порядок и файлы

**Порядок:** E (lru-cache, дёшево/безопасно) → F (reranker, качество retrieval) → G (diagnostics-gate, дорого/ситуативно, off по умолчанию).

**Новые файлы:**
```
src/node/sweep/retrieval/rerank/sweep-reranker-client.ts
src/browser/sweep/quality/diagnostics-delta-verifier.ts  (frontend, реальная модель, post-apply)
```
**Изменяемые (Sweep-owned):**
```
src/node/sweep/token-budget/token-counter.ts             (E: LRU count)
src/node/sweep/model-call-layer/syntax-gate.ts           (E: LRU errorCount)
src/node/sweep/retrieval/sweep-retrieval-orchestrator.ts (F: rerank-шаг + adaptive gating)
src/browser/sweep/trigger-layer/sweep-controller.ts      (G: snapshotBefore + verify в accept-пути)
src/common/sweep/types.ts, preferences-schema.ts         (конфиг E/F/G)
package.json                                             (lru-cache)
```
FIM, Zeta, `HybridRetriever`, `EmbeddingService` — не трогаются.

## Итог по трём интеграциям

- **lru-cache** — снимает повторную токенизацию и парс на горячем пути, складывается с серверным prompt-cache, риск минимальный. Брать первым.
- **Reranker (Qwen3-Reranker, instruction-aware)** — главный quality-апгрейд retrieval; модели уже скачаны, со стороны плагина — только интеграция: клиент `/rerank`, инструкция Qwen3, adaptive-гейтинг по неоднозначности, fail-open, warmup и runtime-страховка на вырожденные скоры (`looksBroken`). Финальный topN не растить.
- **Diagnostics-delta verifier** — переработан в надёжный post-apply: pre-show защиту держит дешёвый tree-sitter syntax-гейт, а типовые/семантические регрессии проверяются по факту на **реальной** модели через естественные маркеры LSP (без shadow-модели, без латентности до показа). Метрика — дельта error-маркеров по файлу (без хрупкого сдвига диапазона). Режимы `warn` (дефолт, только сигнал) и `revert` (откат обратным edit с version-guard, чтобы не стереть ввод пользователя). Fail-open на каждом шаге. По умолчанию OFF.
