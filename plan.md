Решения зафиксированы. Ниже финальный план с учётом ответов.

# Финальный план внедрения fixes.md (locked)

Зафиксированные развилки:
- Профили: оставляем `sweep-default` / `sweep-small` + под-настройка размера для small (1.5B/0.5B).
- `requestModelName`: free-string preference.
- ChromaDB: не трогаем (раздел уборки исключён из объёма).
- Token-budget: внедряем сразу (Qwen2.5-токенизатор), char-budget заменяется.

## A. Фундамент: типы, профили, токен-бюджет

### A1. Профили модели

Файлы: новый `src/common/sweep/profiles.ts`, `src/common/sweep/types.ts`, `src/common/model-types.ts`.

- `SweepProfileId = 'v2-7b' | '1.5b' | '0.5b'` (`as const`-объект, не enum — канон §3).
- `SweepModelProfile` (фиксированная форма, все поля сразу): `contextTokens`, `broadFileLines`, `windowBefore`, `windowAfter`, `maxOutputTokens`, `temperature` — значения из §4.
- Чистая `getSweepProfile(id)`.
- Резолв: `sweep-default → 'v2-7b'`; `sweep-small → sweepSmallSize` (новая настройка).

### A2. Preferences

Файл: `src/browser/preferences/preferences-schema.ts`.

- Новые: `smart-completions.nes.sweepSmallSize` enum `['1.5b','0.5b']` default `'1.5b'`; `smart-completions.nes.requestModelName` (string, default `''`).
- `readNesConfig`: резолвит profile и requestModelName (если пусто → дефолт по публичным ID `sweep-next-edit-v2-7B` / `sweep-next-edit-1.5B` / `sweep-next-edit-0.5B`), кладёт в `NesConfig`.
- Расширить `NesConfig` и `SweepConfig` полями `profile`, `requestModelName` (формы совпадают — `configure` кастует один в другой).

### A3. Token-budget (внедряем сразу)

Файлы: новый `src/node/sweep/token-budget/token-counter.ts`, использование в `context-trimmer.ts`, `sweep-prompt-builder.ts`.

- `TokenCounter` с ленивой инициализацией (канон §12): загрузка Qwen2.5 `tokenizer.json` через Transformers.js `AutoTokenizer` (pure JS/WASM, без native), кэш экземпляра, `ensureReady()` один раз за `predict`, синхронный `count(text)` после готовности.
- Fallback: при сбое загрузки — char-оценка (не блокировать подсказку; канон — ранний выход/деградация).
- Триммер переходит на токены: `budget = profile.contextTokens − profile.maxOutputTokens − templateOverheadTokens`; стоимость секций считается `TokenCounter.count`, не `length/4`.
- Риск/доп. шаг: новая зависимость → пересчитать `npmDepsHash` в `default.nix`; токенайзер-ассет включить в bundle. Отметить в реализации.
- Приёмка: для 1.5B/0.5B промпт реально ≤ 8192 токенов по счётчику; в логах виден `context_profile` и токенные размеры.

## B. P0-правки

### P0-1. Профили контекста на модель

Файлы: `sweep-backend-service.ts`, `services/nes-backend-service.ts`.

- `configure` хранит `profile+requestModelName`; бюджет от `profile.contextTokens`; убрать единый `16384`.
- Приёмка: лог `Sweep backend configured` показывает профиль; малые ≤8192 токенов.

### P0-2. Широкий блок текущего файла

Файлы: `sweep-request-builder.ts`, `src/common/sweep/types.ts` (`SweepRequest.broadFileText`, `broadFileStartLine`), `context-trimmer.ts`, `sweep-prompt-builder.ts`, `file-blocks.ts`.

- Новый `editorBroadWindow(model, position, profile.broadFileLines)`; поле снапшота/запроса.
- Первый блок промпта `<|file_sep|>{currentFilePath}\n{broadFileText}`; приоритет high; режется под токен-бюджет; outline не заменяет.
- Приёмка: нативный блок файла стоит перед retrieval; 7B ≈300 строк, малые меньше.

### P0-3. Окно ±10

Файл: `sweep-request-builder.ts:101-113`.

- `profile.windowBefore/windowAfter` вместо `±20`; те же границы для `getWindowBeforeLastEdit`.
- Приёмка: окно триады = `windowBefore+1+windowAfter`; `:{start}:{end}` соответствует.

### P0-4. Реконструкция original/

Файлы: чистый хелпер в `src/common/sweep/` , вызов в `sweep-request-builder.ts`.

- `reconstructOriginalWindow(currentWindowText, windowStartLine, recentEdits)` реверс-применяет последний пересекающий окно diff (через `unifiedDiffToOriginalUpdated` с обменом состояний).
- Порядок: `getWindowBeforeLastEdit` → реконструкция → fallback current.
- Приёмка: при пересекающих recentEdits `original/` ≠ `current/`; pure unit-тест.

### P0-5. Prefill (2 стратегии)

Файл: `sweep-prompt-builder.ts` (+ согласование с триммером/парсером).

- `computePrefill()` по `inference.py`: default = окно до начала строки курсора; `changesAboveCursor` = первая строка + пустые (за флагом, A/B).
- Prefill из clamped-окна → в `BuiltSweepPrompt.prefill` и в `updated/`; бюджет учитывает prefill.
- Приёмка: обычная правка генерится со строки курсора; склейка `prefill+ответ` корректна.

### P0-6. Decoding

Файлы: `model-call-layer/llama-sweep-client.ts`, `sweep-backend-service.ts`, `sweep-prompt-builder.ts`.

- `temperature: 0`, `cache_prompt: true`, `seed: 0`; `max_tokens` из `profile.maxOutputTokens` (из окна+запас, не занижать; `editVolume` — клампа в пределах профиля). `model = requestModelName`.
- Приёмка: тело запроса содержит указанные поля; стоп-токены без изменений.

### P0-7. Reject-гейты

Файлы: новый `src/node/sweep/model-call-layer/reject-gates.ts` (+ `syntax-check.ts` lazy web-tree-sitter), интеграция в парсер/бекенд.

- Порядок: no-op/whitespace → window-shape → pure-insertion-above-cursor → edit-volume → syntax-regression (code-only).
- Причина reject логируется.
- Приёмка: провалившийся edit не доходит до рендера; unit-тест на каждый гейт.

### P0-8. Prose-профиль

Файлы: `file-mode.ts`, ветвления в `sweep-backend-service.ts`, `sweep-prompt-builder.ts`, `context-trimmer.ts`, `reject-gates.ts`, `sweep-request-builder.ts`.

- Prose: без diagnostics-блока, без syntax-гейта; граница окна по абзацу/предложению; retrieval по заголовкам. Триада/diff/prefill идентичны.
- Приёмка: prose-промпт без diagnostics и parse-гейта, формат каноничный.

## C. P1-правки

- P1-1. История уже глобальная → приоритизация текущего файла + дедуп; опц. dirty-SCM правки. Файлы: `edit-history-store.ts`, `sweep-context-collector.ts`.
- P1-2. Порядок/приоритет триммера (§3): must-keep триада+prefill+recentEdits; high широкий блок+top retrieval; medium error-диагностика у курсора+related; low outline/output/warnings. Понизить error-диагностику ниже recentEdits (`context-trimmer.ts:148-196`).
- P1-3. Дедуп neighbors↔related по `path:start:end` (`sweep-backend-service.ts`, `related-files.ts`).
- P1-4. Уже покрыт A3 (token-budget внедрён сразу).
- P1-5. Telemetry: `tokens_evaluated/cached/truncated` (из ответа llama.cpp), `generation_ms`, `parse_result`, `reject_reason`, `edit_line_count`, `accepted/dismissed/stale`, `model_version`, `context_profile`.
- P1-6. Реальный `nes-priority`: NES подавляет FIM; сигнал через context-key/разделяемое состояние, без отдельного арбитра (канон plan.md).

## D. Тестирование

- Новые unit (node:test): профили+резолв size, token-counter (+fallback), широкий блок, окно ±10, реконструкция original (pure), prefill, каждый reject-гейт, prose-ветка, дедуп, порядок триммера.
- Обновить `nes-prompt.test.ts`, `nes-response-parser.test.ts`.
- Прогон: `npm test`, `npm run lint`, полный `tsc -p tsconfig.json --noEmit`; пересборка Nix с новым `npmDepsHash`.
- После P0 — повторный battlefield (3 модели × сценарии), сравнить acceptance/reject.

## E. Последовательность

A (типы/профили/токенайзер) → P0-1 → P0-2 → P0-3 → (P0-4+P0-5) → P0-7 → P0-8 → P0-6 → P1-1/2/3/5/6.

## Канон разработки (соблюдать при реализации всех правок)

Вся реализация обязана строго следовать `developer_rules/rules.md`:
- комментарии — только «зачем», ≤3 строк, для каждой структуры;
- стабильные формы объектов (поля сразу, один порядок, без `delete`, условные → `null`);
- мономорфные мелкие функции, минимум `any/as`;
- `as const`/`const enum` вместо `enum`, `import type`, без `namespace`;
- `Map`/`Set` для динамики, упакованные массивы, преаллокация, индексный `for` и слияние проходов на горячих путях;
- RegExp один раз в модульной области;
- независимые async — `Promise.all`, объёмы — батчами; токенайзер — ленивая инициализация + кэш;
- новые `LOG.debug` на горячих путях — за `if (process.env.NODE_ENV === 'development')`;
- guard-clauses, short-circuit с дешёвым первым, `??` вместо `||` для `0/""`;
- не нарушать зафиксированное в §8 fixes (стоп-токены, обязательность recentEdits, `overflow→no edit`, номера строк триады, минимальный line-diff парсер как baseline поверх гейтов).
