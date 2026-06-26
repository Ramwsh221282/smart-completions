# Fix: убрать двойную токенизацию `promptTokens`

Устранить лишний полный проход Qwen-токенайзера в `buildSweepPrompt`. Сейчас `promptTokens` считается через `tokenCounter.count(prompt)` по всему собранному промпту, хотя `trimSweepContext` уже посчитал токены по кускам. На горячем пути (каждый predict) это вторая полная токенизация.

Документ содержит **выбранное** решение (не меню вариантов), с привязкой к реальным строкам кода.

## Почему нельзя «просто переиспользовать сумму»

`trimSweepContext` считает токены **сырых кусков** (`window`, `original`, `prefill`, `broad`, каждый neighbor/edit/diagnostic), причём с добавкой `+8` и стоимостью `filePath` на элемент. `count(prompt)` считает **готовый промпт после рендера**, где есть markup, которого в кусках нет: заголовки `<|file_sep|>...:range`, вставленный `<|cursor|>`, переформатирование диффов (`unifiedDiff` → `original:/updated:`), `\n`-джойны секций. Под этот markup в триммере зарезервирована константа `SWEEP_TEMPLATE_OVERHEAD_TOKENS = 128`.

Вывод: точную сумму кусков триммер знает, markup — нет. Корректная оценка = `сумма_кусков + overhead`. Поле `promptTokens` становится **оценкой**, а не точным числом — и это допустимо, потому что оно используется только в telemetry-meta и не управляет логикой.

Сумму кусков не нужно аккумулировать отдельно: она равна `budget − remaining`. Триммер стартует `remaining = budget − window − original − prefill` (строка 137) и далее вычитает только kept-куски (строки 145/179/197/213/227/244/256). Поэтому в конце `budget − remaining` = ровно сумма оставленных кусков, включая их `+8`/`filePath` markup.

## Выбранное решение

- **Оценка в проде, точность в dev.** Убираем полный `count(prompt)` из горячего пути; в dev оставляем точный счёт + калибровочный лог. Один проход токенайзера в dev (консолидировано), ноль лишних — в проде.
- **`consumedTokens` через `budget − remaining`** (минимальная правка, без аккумулятора), с комментарием-инвариантом, чтобы будущие правки `remaining` его не сломали.
- **Имя поля `promptTokens` оставляем**, добавляем doc-комментарий «оценка». Переименование в `estimatedPromptTokens` потянуло бы churn через `BuiltSweepPrompt` → `NesResponseMeta` → telemetry без выигрыша.

---

## Правка 1 — `src/node/sweep/data-formatting-layer/context-trimmer.ts`

### 1.1 Экспортировать константу (строка 17)

```ts
// было:
const SWEEP_TEMPLATE_OVERHEAD_TOKENS = 128;
// стало:
export const SWEEP_TEMPLATE_OVERHEAD_TOKENS = 128;
```

### 1.2 Добавить поле в `TrimmedSweepContext`

В конец интерфейса (после `overflow: boolean;`):

```ts
export interface TrimmedSweepContext {
    // ...существующие поля без изменений...
    prefill: string;
    overflow: boolean;
    /**
     * Сумма токенов оставленных кусков (= budget − remaining).
     * Инвариант: `remaining` декрементится ТОЛЬКО стоимостью kept-кусков
     * (window/original/prefill/broad/diagnostics/edits/neighbors/related/outline/output).
     * Не добавляйте сюда другие резервирования бюджета — иначе значение перестанет
     * отражать реально потреблённый контекст.
     */
    consumedTokens: number;
}
```

### 1.3 Вернуть `consumedTokens` (return-блок, строки 293–305)

Добавить поле после `overflow,`:

```ts
    return {
        windowText: clamped.text,
        broadFileText,
        originalWindowText: originalWindow,
        cursorOffset: clamped.cursorOffset,
        recentEdits: keptEdits,
        neighbors: keptNeighbors,
        relatedFiles: keptRelated,
        diagnostics: keptDiagnostics,
        outline,
        outputSnippets: keptOutput,
        prefill,
        overflow,
        consumedTokens: budget - remaining,   // NEW
    };
```

`budget` (строка 124) и `remaining` (строка 137) уже в скоупе — новых вычислений нет.

---

## Правка 2 — `src/node/sweep/prompt-creating-layer/sweep-prompt-builder.ts`

### 2.1 Импорт константы (строка 6)

```ts
import { trimSweepContext, BuildSweepPromptInput, TrimmedSweepContext, SWEEP_TEMPLATE_OVERHEAD_TOKENS } from '../data-formatting-layer/context-trimmer';
```

### 2.2 Удалить ставший ненужным импорт

```ts
import { charTokenEstimate } from '../token-budget/token-counter';   // ← удалить строку
```

(`charTokenEstimate` использовался только в строке 49, которая ниже заменяется.)

### 2.3 Заменить вычисление `promptTokens` (строка 49)

```ts
// было:
const promptTokens = input.tokenCounter ? input.tokenCounter.count(prompt) : charTokenEstimate(prompt);

// стало:
const estimatedPromptTokens = trimmed.consumedTokens + SWEEP_TEMPLATE_OVERHEAD_TOKENS;
let promptTokens = estimatedPromptTokens;
if (process.env.NODE_ENV === 'development' && input.tokenCounter) {
    // Точный счёт ТОЛЬКО в dev: один проход, переиспользуется и для значения, и для калибровки overhead.
    const exact = input.tokenCounter.count(prompt);
    LOG.debug('Sweep promptTokens estimate delta', {
        estimate: estimatedPromptTokens,
        exact,
        markupActual: exact - trimmed.consumedTokens,   // фактический markup → калибровка константы 128
    });
    promptTokens = exact;
}
```

`tokenMode` оставить как есть (`input.tokenCounter?.mode ?? 'char-fallback'`).

Это убирает полную токенизацию промпта на каждый predict в проде; в dev остаётся ровно один точный проход, который заодно калибрует `SWEEP_TEMPLATE_OVERHEAD_TOKENS`.

---

## Правка 3 — doc-комментарии «оценка» (честность поля)

`promptTokens` теперь оценка. Пометить оба объявления, без переименования.

`src/node/sweep/prompt-creating-layer/sweep-prompt-builder.ts`, интерфейс `BuiltSweepPrompt` (строка 26):

```ts
    /** Оценка размера промпта в токенах (consumed + markup overhead); точное значение только в dev. */
    promptTokens: number;
```

`src/common/nes-types.ts`, `NesResponseMeta` (строка 80):

```ts
    /** Оценка размера промпта в токенах; используется только для telemetry-инспекции. */
    promptTokens?: number;
```

---

## Калибровка константы (как пользоваться)

После внедрения, в dev-режиме лог `Sweep promptTokens estimate delta` показывает `markupActual` — фактический markup (триада + диффы + cursor + джойны) на каждый промпт. Если `markupActual` стабильно заметно больше/меньше 128 — поправить `SWEEP_TEMPLATE_OVERHEAD_TOKENS`. Это самонастройка оверхеда под реальный training-формат, почти бесплатно.

---

## Проверка после внедрения

- `tsc -b` проходит без ошибок; `charTokenEstimate` больше не импортируется в билдере (иначе TS-предупреждение о неиспользуемом импорте).
- Прод (`NODE_ENV !== 'development'`): `tokenCounter.count(prompt)` **не вызывается** в `buildSweepPrompt`; токенайзер на горячем пути работает только внутри триммера по кускам.
- Dev: лог `Sweep promptTokens estimate delta` присутствует, `exact` считается **один раз**.
- `promptTokens` в `NesResponseMeta` остаётся числом (оценка), telemetry-snapshot не ломается.
- `trimmed.consumedTokens` ≥ 0 в норме; при overflow может превышать `budget` (remaining < 0) — это корректно отражает переразмер.

## Что НЕ меняется

- Логика trimming, дедупа, syntax-гейта, telemetry-воронки — не затрагивается.
- `tokenMode`, `contextProfile`, `overflow` в `BuiltSweepPrompt` — без изменений.
- Поведение бюджета и решений триммера — идентично (используется тот же `remaining`, просто дополнительно возвращается его производная).
- Backend `emptyResponse`/`successResponse` читают `prompt.promptTokens` как раньше — сигнатура поля не меняется.
