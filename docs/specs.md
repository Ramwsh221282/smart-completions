# Спецификация: хирургическое удаление Output channels из Sweep

Версия под текущий код (commit `3fbb938`). Цель: убрать источник контекста **Output channels** (Theia Output-панель → `outputSnippets`) из промпта, потому что он нерелевантен для NES/FIM — это логи инструментов и сторонних расширений, не связанные с кодом/буфером текущего файла. Удаление освобождает токен-бюджет под код-релевантный контекст (соседей retrieval, recent edits, диагностики) и убирает неконтролируемый шум.

Это **не** трогает retrieval-ядро (S/G/F, merge, rerank), embedding-индекс, FIM и логику Zeta. Удаляется только канал output.

---

## 0. Критическая находка перед резкой: output шарится с NES

Трассировка по репозиторию показала, что `output` живёт **не только в Sweep**. Он расшарен с NES-модулем (Zeta) через шим-ре-экспорты:

- `src/browser/nes-module/sources/output-source.ts` → `export * from '../../sweep/data-gathering-layer/sources/output-source';`
- `src/common/nes-context/output-filter.ts` → `export * from '../sweep/output-filter';`

При этом:

- `OutputSource` забинден **ровно один раз** — в `smart-completions-frontend-module.ts` (Sweep-путь). Отдельного NES-коллектора, который его дёргает, **нет**.
- `NesRequest.outputSnippets` на фронте **никто не заполняет** — поле и поддержка в NES-билдере есть, но данных в них не приходит. То есть **NES-ветка output вырожденная (dead/vestigial)**.

**Вывод по скоупу.** Удаление разбивается на две фазы:

- **Phase 1 — Sweep (живой путь).** Убирает реально работающий канал output из Sweep-промпта. **Не трогает ни одного файла NES-модуля**, сборка и тесты остаются зелёными. Это закрывает поставленную задачу.
- **Phase 2 — NES + общие файлы (опционально).** Вычищает вырожденную NES-ветку и общие `output-source.ts`/`output-filter.ts`. **Затрагивает Zeta-модуль**, поэтому идёт отдельно и требует явного решения (по действующему правилу «Zeta не трогаем до production-ready Sweep»).

После Phase 1 общие файлы (`output-source.ts`, `output-filter.ts`, тип `SweepOutputSnippet`) остаются в репозитории как orphaned-but-compiling (на них ещё ссылается NES-шим и сам `output-source.ts`). Это сознательный компромисс ради неприкосновенности Zeta. Phase 2 их добивает.

---

## 1. Карта затрагиваемых точек

### Phase 1 (Sweep, обязательная)

| # | Файл | Что сделать |
|---|------|-------------|
| 1 | `src/browser/smart-completions-frontend-module.ts` | убрать import + `bind(OutputSource)` |
| 2 | `src/browser/sweep/data-gathering-layer/sweep-context-collector.ts` | убрать import `OutputSource`, убрать `SweepOutputSnippet` из импорта типов, убрать `@inject` поля, убрать dead `hasErrors`-цикл, убрать сбор output, убрать поле в `CollectedSweepContext`, убрать из `return`, убрать 2 поля лога |
| 3 | `src/browser/sweep/data-formatting-layer/sweep-request-builder.ts` | убрать присваивание `outputSnippets` + поле лога |
| 4 | `src/common/sweep/types.ts` | убрать поле `outputSnippets?` из `SweepRequest` (тип `SweepOutputSnippet` пока **оставить**) |
| 5 | `src/node/sweep/data-formatting-layer/context-trimmer.ts` | убрать `SweepOutputSnippet` из импорта, убрать поле из `BuildSweepPromptInput` и `TrimmedSweepContext`, убрать `keptOutput`-цикл, поле лога и поле в `return` |
| 6 | `src/node/sweep/prompt-creating-layer/sweep-prompt-builder.ts` | убрать render-цикл `output/{channel}` + поле лога |
| 7 | `src/node/sweep/sweep-backend-service.ts` | убрать проброс `outputSnippets: request.outputSnippets` |
| 8 | `test/nes-prompt.test.ts` | поправить Sweep-тест «outline and output» — убрать output, оставить outline |
| 9 | `test/battlefield.integration.test.ts` | убрать `outputSnippets` из вызова `buildSweepPrompt` (вызов `buildNesPrompt` не трогать) |

### Phase 2 (NES + общие, опциональная, трогает Zeta)

| # | Файл | Что сделать |
|---|------|-------------|
| 10 | `src/browser/sweep/data-gathering-layer/sources/output-source.ts` | удалить файл |
| 11 | `src/browser/nes-module/sources/output-source.ts` | удалить файл (шим) |
| 12 | `src/common/sweep/output-filter.ts` | удалить файл |
| 13 | `src/common/nes-context/output-filter.ts` | удалить файл (шим) |
| 14 | `src/common/sweep/types.ts` | удалить интерфейс `SweepOutputSnippet` |
| 15 | `src/common/nes-types.ts` | удалить `NesOutputSnippet` + поле `NesRequest.outputSnippets` |
| 16 | `src/node/nes-module/context-formation/builder.ts` | убрать алиас `OutputSnippet`, поля input/trimmed, `keptOutput`-цикл, render-цикл |
| 17 | `src/node/services/nes-backend-service.ts` | убрать проброс `outputSnippets` |
| 18 | `test/nes-context-sources.test.ts` | убрать 3 теста `extractRelevantOutput` + импорт |
| 19 | `test/battlefield.integration.test.ts` | убрать `extractRelevantOutput`-setup + `outputSnippets` из `buildNesPrompt` |

---

## 2. Phase 1 — пошаговые правки (Sweep)

Порядок: типы/общий слой → бэкенд → фронт → тесты. Так промежуточные состояния минимально «красные».

### 2.1 `src/common/sweep/types.ts` — поле в `SweepRequest`

Убрать строку `outputSnippets?: SweepOutputSnippet[];` из `SweepRequest`. **Интерфейс `SweepOutputSnippet` НЕ трогать** (его ещё использует `output-source.ts`).

```ts
// БЫЛО
export interface SweepRequest {
    // ...
    relatedFiles?: SweepRelatedFile[];
    outline?: string;
    outputSnippets?: SweepOutputSnippet[];   // ← УДАЛИТЬ ЭТУ СТРОКУ
}

// СТАНЕТ
export interface SweepRequest {
    // ...
    relatedFiles?: SweepRelatedFile[];
    outline?: string;
}
```

### 2.2 `src/node/sweep/data-formatting-layer/context-trimmer.ts`

**(a) Импорт (строка 8)** — убрать `SweepOutputSnippet`, остальное оставить:

```ts
// БЫЛО
import { SweepEditVolume, SweepModelId, SweepOutputSnippet, SweepRelatedFile } from '../../../common/sweep/types';
// СТАНЕТ
import { SweepEditVolume, SweepModelId, SweepRelatedFile } from '../../../common/sweep/types';
```

**(b) `BuildSweepPromptInput`** — убрать поле:

```ts
// БЫЛО
    relatedFiles?: SweepRelatedFile[];
    outline?: string;
    outputSnippets?: SweepOutputSnippet[];   // ← УДАЛИТЬ
    editVolume: SweepEditVolume;
// СТАНЕТ
    relatedFiles?: SweepRelatedFile[];
    outline?: string;
    editVolume: SweepEditVolume;
```

**(c) `TrimmedSweepContext`** — убрать поле:

```ts
// БЫЛО
    diagnostics: DiagnosticDTO[];
    outline: string;
    outputSnippets: SweepOutputSnippet[];    // ← УДАЛИТЬ
    prefill: string;
// СТАНЕТ
    diagnostics: DiagnosticDTO[];
    outline: string;
    prefill: string;
```

**(d) Логика триминга** — удалить весь блок `keptOutput` (≈ строки 253–266):

```ts
// УДАЛИТЬ ЦЕЛИКОМ:
    const keptOutput: SweepOutputSnippet[] = [];
    for (const snippet of input.outputSnippets ?? []) {
        const cost = tokenCost(snippet.text, counter) + tokenCost(snippet.channel, counter) + 8;
        if (cost <= remaining) {
            keptOutput.push(snippet);
            remaining -= cost;
        } else {
            if (process.env.NODE_ENV === 'development') {
                LOG.debug('Sweep output snippet trimmed by budget', { channel: snippet.channel, cost, remaining });
            }
            break;
        }
    }
```

**(e) Поле лога** в `LOG.info('Sweep context trimmed', {...})` — убрать `outputOut`:

```ts
// БЫЛО
        outlineChars: outline.length,
        outputOut: keptOutput.length,        // ← УДАЛИТЬ
        prefillTokens: tokenCost(prefill, counter),
// СТАНЕТ
        outlineChars: outline.length,
        prefillTokens: tokenCost(prefill, counter),
```

**(f) `return`** — убрать поле:

```ts
// БЫЛО
        outline,
        outputSnippets: keptOutput,          // ← УДАЛИТЬ
        prefill,
// СТАНЕТ
        outline,
        prefill,
```

### 2.3 `src/node/sweep/prompt-creating-layer/sweep-prompt-builder.ts`

**(a) Render-блок в `buildSweepSections`** (≈ строки 116–118) — удалить цикл output. Соседние блоки outline/diagnostics/diff оставить:

```ts
// БЫЛО
    if (trimmed.diagnostics.length > 0) {
        sections.push(`<|file_sep|>diagnostics/${input.filePath}\n${formatSweepDiagnosticsLines(trimmed.diagnostics)}`);
    }
    for (const snippet of trimmed.outputSnippets) {                                     // ← УДАЛИТЬ
        sections.push(`<|file_sep|>output/${snippet.channel}\n${normalizeCrlf(snippet.text)}`); // ← УДАЛИТЬ
    }                                                                                   // ← УДАЛИТЬ

    sections.push(...formatSweepDiffBlocks(trimmed.recentEdits));
// СТАНЕТ
    if (trimmed.diagnostics.length > 0) {
        sections.push(`<|file_sep|>diagnostics/${input.filePath}\n${formatSweepDiagnosticsLines(trimmed.diagnostics)}`);
    }

    sections.push(...formatSweepDiffBlocks(trimmed.recentEdits));
```

> Проверить: если после удаления `normalizeCrlf` больше нигде в файле не используется — убрать и его импорт. Если используется (вероятно, да — для других блоков) — оставить.

**(b) Поле лога** (≈ строка 77) — убрать `outputSnippets`:

```ts
// БЫЛО
        hasOutline: Boolean(trimmed.outline),
        outputSnippets: trimmed.outputSnippets.length,   // ← УДАЛИТЬ
        dedupDropped: deduped.dropped,
// СТАНЕТ
        hasOutline: Boolean(trimmed.outline),
        dedupDropped: deduped.dropped,
```

### 2.4 `src/node/sweep/sweep-backend-service.ts`

Убрать проброс (≈ строка 104) в объекте, передаваемом в `buildSweepPrompt`:

```ts
// БЫЛО
                relatedFiles: request.relatedFiles,
                outline: request.outline,
                outputSnippets: request.outputSnippets,   // ← УДАЛИТЬ
                editVolume: this.config.editVolume,
// СТАНЕТ
                relatedFiles: request.relatedFiles,
                outline: request.outline,
                editVolume: this.config.editVolume,
```

### 2.5 `src/browser/sweep/data-gathering-layer/sweep-context-collector.ts`

**(a) Импорты** — убрать import `OutputSource` (строка 12) и `SweepOutputSnippet` из импорта типов (строка 10):

```ts
// БЫЛО
import { SweepOutputSnippet, SweepRelatedFile } from '../../../common/sweep/types';
// СТАНЕТ
import { SweepRelatedFile } from '../../../common/sweep/types';

// УДАЛИТЬ СТРОКУ ЦЕЛИКОМ:
import { OutputSource } from './sources/output-source';
```

**(b) `CollectedSweepContext`** — убрать поле:

```ts
// БЫЛО
export interface CollectedSweepContext {
    relatedFiles: SweepRelatedFile[];
    outline?: string;
    outputSnippets: SweepOutputSnippet[];    // ← УДАЛИТЬ
}
// СТАНЕТ
export interface CollectedSweepContext {
    relatedFiles: SweepRelatedFile[];
    outline?: string;
}
```

**(c) `@inject` поля** — убрать инъекцию `outputSource` (строка 47, вместе с комментарием 46):

```ts
// УДАЛИТЬ:
    // Theia Output каналы для построения output/ псевдофайла в промпте.
    @inject(OutputSource) protected readonly outputSource!: OutputSource;
```

**(d) Тело `collect()`** — удалить dead `hasErrors`-цикл и сбор output (строки 93–101). `hasErrors` использовался **только** для гейта output, поэтому удаляется целиком:

```ts
// УДАЛИТЬ ЦЕЛИКОМ (строки 93–101):
        let hasErrors = false;
        for (let i = 0; i < params.diagnostics.length; i++) {
            if (params.diagnostics[i].severity === 'error') {
                hasErrors = true;
                break;
            }
        }
        // Output пропускается при наличии ошибок, чтобы не перегружать промпт нерелевантным шумом сборки.
        const outputSnippets = hasErrors ? [] : this.safe(() => this.outputSource.collect(), [] as SweepOutputSnippet[], 'output');
```

**(e) Поля лога** в `LOG.info('Sweep context collected', {...})` — убрать `outputSnippets` и `outputSkippedDueToErrors`:

```ts
// БЫЛО
            hasOutline: Boolean(outline),
            diagnostics: params.diagnostics.length,
            outputSnippets: outputSnippets.length,          // ← УДАЛИТЬ
            outputSkippedDueToErrors: hasErrors,            // ← УДАЛИТЬ
        });
// СТАНЕТ
            hasOutline: Boolean(outline),
            diagnostics: params.diagnostics.length,
        });
```

**(f) `return`** — убрать `outputSnippets`:

```ts
// БЫЛО
        return { relatedFiles, outline: outline || undefined, outputSnippets };
// СТАНЕТ
        return { relatedFiles, outline: outline || undefined };
```

> Примечание: `this.safe(...)` остаётся (используется для других источников — outline и т.д.). Удаляется только output-вызов.

### 2.6 `src/browser/sweep/data-formatting-layer/sweep-request-builder.ts`

**(a) Сборка запроса** (≈ строка 99) — убрать поле:

```ts
// БЫЛО
            relatedFiles: collected.relatedFiles,
            outline: collected.outline,
            outputSnippets: collected.outputSnippets,   // ← УДАЛИТЬ
        };
// СТАНЕТ
            relatedFiles: collected.relatedFiles,
            outline: collected.outline,
        };
```

**(b) Поле лога** (≈ строка 108) — убрать `outputSnippets`:

```ts
// БЫЛО
            hasOutline: Boolean(request.outline),
            outputSnippets: request.outputSnippets.length,   // ← УДАЛИТЬ
        });
// СТАНЕТ
            hasOutline: Boolean(request.outline),
        });
```

### 2.7 `src/browser/smart-completions-frontend-module.ts`

**(a) Импорт** (строка 17) — удалить:

```ts
// УДАЛИТЬ СТРОКУ:
import { OutputSource } from './sweep/data-gathering-layer/sources/output-source';
```

**(b) DI-биндинг** (строка 46) — удалить:

```ts
// УДАЛИТЬ СТРОКУ:
    bind(OutputSource).toSelf().inSingletonScope();
```

### 2.8 `test/nes-prompt.test.ts` — Sweep-тест «outline and output»

Тест на строке ≈309 проверяет и outline, и output для Sweep. Убрать output-часть, оставить outline:

```ts
// БЫЛО
test('sweep outline and output render as pseudo-files in zone B', () => {
    const built = buildSweepPrompt({
        modelId: 'sweep-default',
        filePath: 'src/a.ts',
        windowText: 'const value = 1;',
        cursorOffset: 5,
        recentEdits,
        editVolume: 'medium',
        outline: 'class A [1:0-3:1]\n  m [2:2-2:9] <-- cursor',
        outputSnippets: [{ channel: 'build', text: 'ERROR src/a.ts:1: boom' }],   // ← УДАЛИТЬ
    });
    assert.ok(built.prompt.includes('<|file_sep|>outline/src/a.ts\nclass A [1:0-3:1]'));
    assert.ok(built.prompt.includes('<|file_sep|>output/build\nERROR src/a.ts:1: boom'));  // ← УДАЛИТЬ
});

// СТАНЕТ
test('sweep outline renders as pseudo-file in zone B', () => {
    const built = buildSweepPrompt({
        modelId: 'sweep-default',
        filePath: 'src/a.ts',
        windowText: 'const value = 1;',
        cursorOffset: 5,
        recentEdits,
        editVolume: 'medium',
        outline: 'class A [1:0-3:1]\n  m [2:2-2:9] <-- cursor',
    });
    assert.ok(built.prompt.includes('<|file_sep|>outline/src/a.ts\nclass A [1:0-3:1]'));
});
```

### 2.9 `test/battlefield.integration.test.ts` — вызов `buildSweepPrompt`

Убрать `outputSnippets,` **только** из объекта `buildSweepPrompt` (≈ строка 308). Вызов `buildNesPrompt` (≈ строка 325) и setup `extractRelevantOutput`/`outputSnippets` (строки 280–281) в Phase 1 **оставить** — они нужны NES-ветке до Phase 2.

```ts
// В объекте buildSweepPrompt({ ... }):
//   relatedFiles,
//   outline,
//   outputSnippets,    ← УДАЛИТЬ ЭТУ СТРОКУ (только в buildSweepPrompt-ветке)
//   editVolume: 'medium',
```

---

## 3. Проверка Phase 1

```bash
cd smart-completions
# 1. Не осталось ли Sweep-ссылок на output (ожидаем: только output-source.ts, output-filter.ts и NES)
grep -rn "outputSnippets\|OutputSource" src/browser/sweep src/node/sweep src/common/sweep/types.ts
#   → ничего, кроме (возможно) output-source.ts

# 2. Компиляция исходников
npx tsc -b              # допустим только pre-existing варнинг moduleResolution=node10

# 3. Тесты
npx tsc -p test/tsconfig.json --ignoreDeprecations 6.0
node --test lib-test/test/*.test.js
#   → 0 fail; число тестов на 0–1 меньше (Sweep output-ассерт убран)
```

### Критерии приёмки Phase 1

- Sweep-промпт больше не содержит блоков `<|file_sep|>output/{channel}`.
- `grep` по `src/browser/sweep`, `src/node/sweep`, `src/common/sweep/types.ts` не находит `outputSnippets`/`OutputSource` (кроме самого `output-source.ts`, который пока жив).
- `tsc -b` без новых ошибок; `node --test` — 0 fail.
- Ни один файл `src/*/nes-module/`, `src/node/services/nes-backend-service.ts`, `src/common/nes-types.ts` **не изменён**.
- `OutputSource`/`output-filter.ts`/`SweepOutputSnippet` ещё существуют (orphaned), сборка зелёная.

---

## 4. Phase 2 — полная зачистка (опционально, трогает Zeta)

Выполнять только при явном решении убрать output и из NES. После этого `output` исчезает из репозитория полностью.

### 4.1 Удалить файлы

```bash
rm src/browser/sweep/data-gathering-layer/sources/output-source.ts
rm src/browser/nes-module/sources/output-source.ts        # шим
rm src/common/sweep/output-filter.ts
rm src/common/nes-context/output-filter.ts                # шим
```

### 4.2 `src/common/sweep/types.ts` — удалить интерфейс

```ts
// УДАЛИТЬ ЦЕЛИКОМ (вместе с doc-комментарием):
export interface SweepOutputSnippet {
    channel: string;
    text: string;
}
```

### 4.3 `src/common/nes-types.ts`

```ts
// УДАЛИТЬ интерфейс:
export interface NesOutputSnippet {
    channel: string;
    text: string;
}
// И поле в NesRequest:
    outputSnippets?: NesOutputSnippet[];   // ← УДАЛИТЬ
```

### 4.4 `src/node/nes-module/context-formation/builder.ts`

Убрать: импорт `NesOutputSnippet` (строка 4), алиас `export type OutputSnippet = NesOutputSnippet;` (строка 13), поле `outputSnippets?` в input (строка 32), поле в trimmed-структуре (строка 132), `keptOutput`-цикл (строки 252–253…), render-цикл (строка 299). Зеркалит правки §2.2–2.3, но в NES-билдере.

### 4.5 `src/node/services/nes-backend-service.ts`

```ts
// УДАЛИТЬ (строка 79):
                outputSnippets: request.outputSnippets,
```

### 4.6 Тесты

- `test/nes-context-sources.test.ts`: удалить импорт `extractRelevantOutput, DEFAULT_OUTPUT_FILTER` (строка 15) и три теста (строки 92, 110 + связанные ассерты).
- `test/battlefield.integration.test.ts`: удалить setup `extractRelevantOutput`/`outputSnippets` (строки 280–281, импорт строка 16) и `outputSnippets,` из `buildNesPrompt`.
- `test/nes-prompt.test.ts`: если в zeta-тесте есть output — убрать.

### 4.7 Проверка Phase 2

```bash
grep -rn "outputSnippets\|OutputSource\|extractRelevantOutput\|OutputSnippet\|output-filter" src/ test/
#   → пусто
npx tsc -b
npx tsc -p test/tsconfig.json --ignoreDeprecations 6.0 && node --test lib-test/test/*.test.js
```

### Критерии приёмки Phase 2

- `grep` по `src/` и `test/` не находит ни `outputSnippets`, ни `OutputSource`, ни `extractRelevantOutput`, ни `output-filter`.
- Удалены 4 файла (2 источника + 2 шима).
- `tsc -b` и `node --test` зелёные.

---

## 5. Чек-лист «снизу вверх» (для коммита)

**Phase 1 (один коммит):**

1. [ ] `common/sweep/types.ts` — поле `SweepRequest.outputSnippets`
2. [ ] `node/sweep/context-trimmer.ts` — импорт, 2 поля, цикл, лог, return
3. [ ] `node/sweep/sweep-prompt-builder.ts` — render-цикл + лог (+ проверить `normalizeCrlf`)
4. [ ] `node/sweep/sweep-backend-service.ts` — проброс
5. [ ] `browser/sweep/sweep-context-collector.ts` — импорты, поле, inject, hasErrors-цикл, сбор, лог, return
6. [ ] `browser/sweep/sweep-request-builder.ts` — присваивание + лог
7. [ ] `browser/smart-completions-frontend-module.ts` — import + bind
8. [ ] `test/nes-prompt.test.ts` — Sweep-тест outline/output
9. [ ] `test/battlefield.integration.test.ts` — вызов `buildSweepPrompt`
10. [ ] `tsc -b` + `node --test` зелёные

**Phase 2 (отдельный коммит, по решению):** пункты 10–19 из §1 + проверки §4.7.

---

## 6. Что НЕ затрагивается (границы)

- Retrieval-ядро: `SweepRetrievalOrchestrator`, каналы S/G/F, `mergeNeighborChannels`, reranker — без изменений.
- Embedding-индекс, LanceDB, BM25, CodeGraph, fuzzy — без изменений.
- Остальные источники контекста: `HierarchyRelatedSource`, `SearchRelatedSource`, `ScmChangedFilesSource`, `SymbolSource` (outline), `WorkspaceFiles` — без изменений.
- FIM-модуль — без изменений.
- Phase 1 не трогает ни одного файла Zeta/NES-модуля.