# План доработок Sweep NES: каноничный формат + reject-гейты

Документ описывает конкретные правки, чтобы привести Sweep Next Edit Suggestion в плагине `smart-completions` к формату, на котором модели Sweep реально обучены, и добавить output-гейты качества. Цель — выжать из моделей Sweep максимум на их же обученном распределении.

## 1. Scope

**В рамках:**
- Каноничный формат промпта Sweep (широкий блок файла, порядок секций, триада, prefill).
- Профили моделей под разный контекст и размер окна.
- Reject-гейты в парсере ответа.
- Decoding-параметры под карточку модели.
- Prose-профиль (markdown/typst/latex/plain) — отдельная ветка поведения.

**Вне рамок (обсуждается отдельно, позже):**
- Обогащение retrieval: CodeGraph, fuzzy, trigram, camelCase-токенизация.
- Reranker.
- Переход с char-budget на полноценный token-budget рассматривается как P1, но детальная реализация — отдельно.

Транспорт остаётся llama.server по HTTP, `stream: false`. ChromaDB удаляется, остаётся LanceDB (отдельный пункт уборки).

## 2. Источники истины (проверено)

Все правки опираются на два официальных источника Sweep, а не на догадки:

- **Карточка `sweepai/sweep-next-edit-v2-7B`** — каноничный формат промпта и фраза «секция file_path = ~300 строк контекста файла вокруг курсора»; триада идёт с номерами строк `:{start}:{end}`.
- **`inference.py` из репозитория v2-7B** — `PROMPT_TEMPLATE`, `DIFF_FORMAT`, `FileChunk.to_string()`, `compute_prefill()` с двумя режимами, фильтр `is_pure_insertion_above_cursor()`.
- **Карточки `sweep-next-edit-1.5B` / `0.5B`** — context length 8192 токенов, base Qwen2.5-Coder, задача «переписать 21-строчный сниппет», greedy decoding (temperature=0).
- **Блог Sweep (oss-next-edit)** — фиксированное окно ±10 (21 строка) выбрано экспериментально; формат `original:/updated:` победил unified diff в генетическом поиске; лишние токены непропорционально вредят малым моделям; tree-sitter parse reward и size regularization в RL.

Ключевой проверенный факт-баг: малые модели держат **8192** токенов, а текущий `nes.contextSize = 16384` — это переполнение для 0.5B/1.5B.

## 3. Каноничный целевой формат промпта

Целевая разметка (порядок блоков сверху вниз). Триада `original/ → current/ → updated/` всегда замыкает промпт.

```
<|file_sep|>{currentFilePath}
{широкий контекст текущего файла: ~N строк вокруг курсора по профилю}
<|file_sep|>{retrievalChunkPath_1}
{retrieval chunk 1}
<|file_sep|>{retrievalChunkPath_2}
{retrieval chunk 2}
<|file_sep|>{changedFilePath_1}.diff
original:
{код до правки}
updated:
{код после правки}
<|file_sep|>original/{currentFilePath}:{startLine}:{endLine}
{окно ДО последней правки}
<|file_sep|>current/{currentFilePath}:{startLine}:{endLine}
{окно с <|cursor|> в позиции курсора}
<|file_sep|>updated/{currentFilePath}:{startLine}:{endLine}
{prefill}
```

**Нативные блоки** (модель на них обучена): широкий блок файла, retrieval-чанки, diff-блоки, триада.

**Расширения плагина** (модель на них НЕ обучена): `outline/`, `diagnostics/`, `output/`. Они не входят в каноничный формат. Размещаются как один смежный блок в retrieval-зоне (между широким файлом и diff-блоками), каждый включается флагом, в trimming имеют низкий приоритет. Исключение — error-диагностика в радиусе курсора может получать средний приоритет.

Стоп-токены: `['<|file_sep|>', '<|endoftext|>']` — уже корректно, не менять.

## 4. Профили моделей

Сейчас один `contextSize` и один `editVolume` на все Sweep. Нужен профиль на модель. Значения окна/файла — стартовые, подлежат A/B.

| Параметр | sweep-v2-7b | sweep-1.5b | sweep-0.5b |
|---|---|---|---|
| `contextTokens` | 32768 | 8192 | 8192 |
| `broadFileLines` (±вокруг курсора) | ~300 (±150) | ~120–180 | ~80–140 |
| `windowBefore / windowAfter` | 10 / 10 | 10 / 10 | 8–10 / 8–10 |
| `maxOutputTokens` | до 1024 | 512–768 | 384–512 |
| `temperature` | 0 | 0 | 0 |

`contextTokens` для малых моделей **обязательно** ≤ 8192, иначе промпт обрезается сервером.

Связанная правка (из ревью, п.11): развести `uiModelId` / `requestModelName` / `profile`, потому что реальные имена на сервере — `sweep-next-edit-v2-7B`, `sweep-next-edit-1.5B`, `sweep-next-edit-0.5B`, и текущий маппинг `sweep-small → sweep-next-edit-small` не соответствует публичным ID. Имя модели для запроса вынести в preference, не хардкодить.

## 5. Правки P0 (обязательно)

Каждая правка: что, где (по `Source File Map` спецификации), текущее состояние → целевое, критерий приёмки.

### P0-1. Профили контекста на модель (чинит тихий баг)

- **Где:** `src/common/nes-types.ts` (типы профиля), `src/common/model-types.ts` (NesModelId), `src/browser/preferences/preferences-schema.ts` (preferences), `src/node/sweep/sweep-backend-service.ts` (применение).
- **Сейчас:** `nes.contextSize = 16384` единый.
- **Цель:** `SweepModelProfile` с полями из таблицы §4; backend выбирает профиль по `modelId`.
- **Приёмка:** для 0.5B/1.5B итоговый промпт никогда не превышает 8192 токенов (или char-эквивалент до перехода на токены); для 7B используется до 32768; в логах виден выбранный профиль.

### P0-2. Широкий блок текущего файла (главный недобор качества)

- **Где:** сбор — `src/browser/sweep/data-formatting-layer/sweep-request-builder.ts` (снять ~N строк вокруг курсора из Monaco-модели); рендер — `src/node/sweep/prompt-creating-layer/sweep-prompt-builder.ts` (добавить блок первым).
- **Сейчас:** текущий файл представлен только окном ±20 в триаде; широкого блока нет.
- **Цель:** первый блок промпта `<|file_sep|>{currentFilePath}\n{~broadFileLines строк вокруг курсора}`, размер по профилю, обрезается под бюджет.
- **Приёмка:** в собранном промпте присутствует нативный блок текущего файла перед retrieval; для 7B ~300 строк; для малых уменьшен; outline его НЕ заменяет и остаётся отдельно.

### P0-3. Окно ±10 вместо ±20

- **Где:** `src/browser/sweep/data-formatting-layer/sweep-request-builder.ts` (строки snapshot окна).
- **Сейчас:** `position.lineNumber - 20 … + 20` (41 строка).
- **Цель:** `windowBefore/windowAfter` из профиля (дефолт 10/10, 21 строка); параметризовать, не хардкодить 20.
- **Приёмка:** окно триады = `windowBefore + 1 + windowAfter` строк по профилю; номера строк `:{start}:{end}` в триаде соответствуют реальному диапазону окна.

### P0-4. Реконструкция `original/` из истории правок (оживить сигнал триады)

- **Где:** `src/browser/sweep/data-formatting-layer/sweep-request-builder.ts` или backend `src/node/sweep/sweep-backend-service.ts`; источник — `src/common/sweep/*` edit-history store, `recentEdits`.
- **Сейчас:** `originalWindowText` = окно до правки «when available; otherwise the current window». При отсутствии снапшота `original == current`, и триада теряет дельту «было→стало».
- **Цель:** всегда реконструировать до-правочное окно, применив обратную операцию последней правки к текущему окну, чтобы `original ≠ current`. Если реконструкция невозможна — это сигнал, а не повод дублировать current.
- **Приёмка:** при наличии recentEdits секции `original/` и `current/` различаются; модель видит трансформацию.

### P0-5. Prefill (две стратегии)

- **Где:** `src/node/sweep/prompt-creating-layer/sweep-prompt-builder.ts` (генерация prefill), парсер уже склеивает `prefill + rawCompletion`.
- **Сейчас:** prefill пустой по умолчанию; модель генерит всё окно с нуля.
- **Цель:** по логике `compute_prefill()` из `inference.py`:
  - default: prefill = окно `current/` до начала строки курсора;
  - режим `changesAboveCursor`: prefill = первая строка окна + последующие пустые строки.
- **Приёмка:** при обычной правке модель генерирует только от строки курсора; меньше drift и truncation. Примечание: твой парсер `diffWindows()` уже схлопывает идентичную регенерацию в минимальный edit, поэтому prefill снижает латентность/drift, но не является единственной защитой — приоритет ниже P0-2.

### P0-6. Decoding под карточку

- **Где:** `src/node/sweep/model-call-layer/*` (тело запроса), `src/node/sweep/sweep-backend-service.ts`.
- **Сейчас:** `temperature: 0.05`, `max_tokens` по editVolume (128/256/512).
- **Цель:** `temperature: 0` (greedy, по карточке); `max_tokens` из профиля, выводить из размера окна + запас, не занижать; добавить `cache_prompt: true` и `seed: 0`.
- **Приёмка:** запрос содержит `temperature:0`, `cache_prompt:true`, `max_tokens` по профилю; стоп-токены без изменений. Импакт temperature 0 vs 0.05 малый — делать для соответствия, не ради скачка качества.

### P0-7. Reject-гейты в парсере

- **Где:** `src/node/sweep/model-call-layer/*` (парсер, расширение `parseSweepCompletion`).
- **Сейчас:** чистка маркеров, склейка prefill, NO_EDITS, минимальный line-diff. Гейтов нет.
- **Цель:** добавить reject-фильтры до отдачи edit (детали в §7).
- **Приёмка:** edit, проваливший гейт, не доходит до рендера; причина reject логируется.

### P0-8. Prose-профиль

- **Где:** `src/browser/shared/file-mode.ts` (классификация), ветвления в `sweep-backend-service.ts`, `sweep-prompt-builder.ts`, парсере.
- **Сейчас:** проза поддержана структурно (chunking), но Sweep-пайплайн чисто кодовый; кодовые механизмы применяются к прозе вслепую.
- **Цель:** профиль по `languageId`/`fileMode`, который для прозы (markdown/typst/latex/plain): отключает syntax-regression гейт и diagnostics-блок, меняет «логическую границу» окна на конец абзаца/предложения, retrieval ведёт по заголовкам/секциям; формат (триада, diff `original:/updated:`, prefill) сохраняется идентичным.
- **Приёмка:** в prose-режиме не подаётся diagnostics-блок, не применяется tree-sitter parse gate; формат промпта остаётся каноничным.

## 6. Правки P1 (сильно повышают acceptance)

- **P1-1. Cross-file recent edits.** `getRecentEdits(uri, 8)` сейчас только текущий файл. Расширить: текущий файл (выше приоритет) + правки из других открытых/изменённых файлов + dirty SCM с недавней активностью. Формат `recent_changes` уже несёт пути — дыра в сборе, не в формате. Где: `src/common/sweep/*` edit-history store, `sweep-context-collector.ts`.
- **P1-2. Порядок и trimming-приоритет.** Привести порядок к §3. Trimming: must-keep = триада + prefill, recent edits; high = широкий блок файла, top retrieval; medium = error-диагностика у курсора, related files; low = outline, output, warning-диагностика. Сейчас error-диагностика стоит выше recent edits — понизить: вытеснять recent edits диагностикой только при локальной ошибке в радиусе курсора. Где: `src/node/sweep/data-formatting-layer/*` (trimming).
- **P1-3. Дедуп retrieval/related/context.** RAG-neighbors и related files (search/LSP/SCM) могут отдавать одно и то же окно файла. Дедуплицировать по пути+диапазону до сборки промпта. Где: `sweep-backend-service.ts` / `src/common/sweep/*` ranking.
- **P1-4. Token-aware budget.** Сейчас char-estimate. Перейти на токены. Вариант с минимальной латентностью — локальный токенизатор Qwen2.5 (Sweep на его базе), т.к. `/tokenize` добавляет round-trip, а GPT-BPE токенизаторы неточны для Qwen. Где: `sweep-prompt-builder.ts` trimming.
- **P1-5. Telemetry.** Логировать `tokens_evaluated`, `tokens_cached`, `truncated`, `generation_ms`, `parse_result`, `reject_reason`, `edit_line_count`, `accepted/dismissed/stale`, `model_version`, `context_profile`. Поля `tokens_cached/evaluated/truncated` отдаёт сам llama.cpp в ответе.
- **P1-6. Настоящий `nes-priority`.** Сейчас объявлен, но не реализован отдельной веткой. Реализовать как приоритет NES над FIM при координации.

## 7. Reject-гейты (детализация P0-7)

Порядок проверки — от дешёвых к дорогим, первая сработавшая отклоняет edit.

- **No-op / whitespace-only.** Если изменение только форматное и не связано с recent-edit паттерном — не показывать View Zone.
- **Window-shape.** Если число строк ответа сильно больше/меньше editable-окна — вероятный drift, reject или сильный штраф.
- **Pure-insertion-above-cursor.** Отбраковывать completions, которые только вставляют строки выше курсора, не меняя строку курсора. Это штатный фильтр `is_pure_insertion_above_cursor()` из `inference.py` Sweep — низкоценное предсказание.
- **Edit-volume.** Если diff затрагивает слишком много несмежных строк — reject. Блог Sweep отмечает: чрезмерные вставки/удаления снижают acceptance.
- **Syntax/LSP regression (только code-режим).** Применить edit во временную модель, прогнать tree-sitter parse (у тебя уже есть `web-tree-sitter`) или сравнить дельту Monaco-диагностики; reject при новых ошибках. Это inference-аналог tree-sitter parse reward из RL Sweep. В prose-режиме отключён (P0-8).

## 8. Что НЕ трогать (проверено корректным)

- **Номера строк в триаде** `:{start}:{end}` — совпадают с каноничным форматом карточки v2-7B. Оставить.
- **Стоп-токены** `['<|file_sep|>', '<|endoftext|>']` — корректно.
- **Обязательность recent edits** (NES не запускается без истории) — корректно.
- **`overflow → no edit`** при непомещении триады в бюджет — корректно.
- **Минимальный line-diff парсер** (`diffWindows` по общему префиксу/суффиксу) — корректный baseline, поверх него навешиваются гейты.
- **`temperature` менять с 0.05 на 0** — делать, но импакт near-zero, не ждать качественного скачка.

## 9. Последовательность внедрения

Рекомендуемый порядок по убыванию отдачи:

1. **P0-1** (баг контекста) — снимает тихую деградацию малых моделей. Делать первым.
2. **P0-2** (широкий блок файла) — наибольший прирост качества.
3. **P0-3** (окно ±10) — возврат в обученный режим окна.
4. **P0-4** (реконструкция `original/`) + **P0-5** (prefill) — оживляют сигнал триады и ограничивают генерацию.
5. **P0-7** (reject-гейты) — «почти правильный edit хуже отсутствия».
6. **P0-8** (prose-профиль) — без него ключевое требование по прозе не выполнено.
7. **P0-6** (decoding) — дёшево, для соответствия.
8. Далее P1 по acceptance.

После P0-1…P0-8 имеет смысл повторно прогнать battlefield-матрицу (3 модели × сценарии) и сравнить acceptance/reject до и после.

## 10. Открытые вопросы для A/B

Решаются замером на реальных NES-сценариях из твоего корпуса, не теорией:

- Точные `broadFileLines` для каждого профиля (стартовые значения §4 — гипотеза).
- Размещение расширений (`outline/diagnostics/output`): в retrieval-зоне vs перед триадой; и какие из них вообще дают прирост, а не шум — гонять с флагами включения.
- `windowBefore/After` для 0.5B: 8/8 vs 10/10.
- Нужен ли prefill-режим `changesAboveCursor` на практике, или достаточно default-стратегии.
- Граница «edit-volume» для reject (сколько несмежных строк = drift).
- Точный verdict по `temperature` 0 vs 0.05 на твоих данных (ожидается near-zero разница).

---

**Резюме:** P0-1 и P0-2 закрывают тихий баг и главный недобор качества; P0-3/4/5 возвращают модель в обученный режим триады; P0-7 не пускает плохие edit'ы к пользователю; P0-8 делает прозу полноценной веткой. Это и есть «максимум из Sweep» в пределах каноничного формата. Обогащение retrieval (CodeGraph/fuzzy) — следующий шаг, и оно вторично, потому что для Sweep NES retrieval — не главный сигнал.
