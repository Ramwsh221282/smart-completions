# Выполненные фиксы Sweep NES

Документ фиксирует, какие изменения из `fixes.md` были реализованы в текущем наборе изменений по `git status`, и зачем они нужны.

## Источник проверки

- `git status --short` запускался из корня репозитория: `$HOME/my-nix-cfg`.
- Основные изменения находятся в `smart-completions/src/**`.
- Сопутствующие изменения в `smart-completions/lib/**` и `smart-completions/lib-test/**` являются сгенерированными артефактами сборки/тестовой сборки.
- Изменения в `package.json`, `package-lock.json` и `node_modules/**` связаны с добавлением runtime-зависимости для token-aware budget.

## P0-1. Профили контекста на модель

Сделано:

- Добавлен `src/common/sweep/profiles.ts` с профилями `v2-7b`, `1.5b`, `0.5b`.
- В профиль вынесены `contextTokens`, `broadFileLines`, `windowBefore`, `windowAfter`, `maxOutputTokens`, `temperature`.
- Добавлены настройки `smart-completions.nes.sweepSmallSize` и `smart-completions.nes.requestModelName`.
- `NesConfig` и `SweepConfig` теперь несут resolved `profile` и фактическое `requestModelName` для llama.cpp.

Зачем:

- У малых Sweep-моделей контекст 8192 токена, поэтому единый `contextSize = 16384` приводил к тихому переполнению и деградации качества.
- Реальные имена моделей на llama.cpp отличаются от UI-id, поэтому `requestModelName` вынесен в настройку и default берётся из профиля.

## P0-2. Широкий блок текущего файла

Сделано:

- `SweepRequestBuilder` теперь снимает `broadFileText` и `broadFileStartLine` вокруг курсора по `profile.broadFileLines`.
- `SweepRequest`/`NesRequest` расширены полями широкого контекста.
- Добавлен `formatSweepCurrentFileBlock()`.
- `buildSweepPrompt()` вставляет широкий блок текущего файла первым блоком prompt.

Зачем:

- Sweep v2 обучался видеть широкий file chunk перед retrieval и diff-блоками.
- Раньше текущий файл был представлен только узкой триадой, из-за чего модель недополучала локальный контекст.

## P0-3. Окно триады по профилю вместо хардкода ±20

Сделано:

- `editorWindow()` больше не использует фиксированные 20 строк до/после курсора.
- Размер окна берётся из `profile.windowBefore` и `profile.windowAfter`.
- Для `v2-7b` и `1.5b` используется 10/10, для `0.5b` используется 8/8.

Зачем:

- Каноничный Sweep-режим работает вокруг короткого окна около 21 строки.
- Уменьшение окна возвращает prompt ближе к обученному распределению и экономит context budget.

## P0-4. Реконструкция `original/` из истории правок

Сделано:

- Добавлен `src/common/sweep/original-window-reconstruction.ts`.
- При отсутствии сохранённого pre-edit snapshot `SweepRequestBuilder` пытается восстановить `originalWindowText` обратным применением последнего unified diff к текущему окну.
- В логах snapshot теперь видно, откуда взят original: `snapshot`, `reconstructed` или `current-fallback`.

Зачем:

- Если `original/` совпадает с `current/`, финальная триада теряет главный NES-сигнал «было → стало».
- Реконструкция сохраняет полезную дельту даже при timing race или отсутствии прямого snapshot.

## P0-5. Prefill для `updated/`

Сделано:

- В `trimSweepContext()` добавлен default prefill.
- Prefill равен тексту от начала окна до начала строки с курсором.
- Parser уже склеивает `prefill + rawCompletion`, поэтому модель продолжает `updated/` с редактируемой строки.

Зачем:

- Модель не должна генерировать всё окно с нуля.
- Prefill уменьшает drift, снижает лишнюю генерацию и помогает сохранить неизменённые строки выше курсора.

## P0-6. Decoding под карточку Sweep

Сделано:

- Температура берётся из Sweep-профиля и равна `0`.
- `max_tokens` теперь рассчитывается из `editVolume` с клампом по `profile.maxOutputTokens`.
- В запрос llama.cpp добавлены `cache_prompt: true` и `seed: 0`.
- Исправлен маппинг имени модели: больше нет `sweep-next-edit-small`; используются реальные default-имена `sweep-next-edit-v2-7B`, `sweep-next-edit-1.5B`, `sweep-next-edit-0.5B` или пользовательский `requestModelName`.

Зачем:

- Карточки Sweep указывают greedy decoding.
- Правильный `max_tokens` и имя модели предотвращают недогенерацию, переполнение и ошибочный вызов несуществующей модели.

## P0-7. Reject-гейты ответа

Сделано:

- Добавлен `src/node/sweep/model-call-layer/reject-gates.ts`.
- `parseSweepCompletion()` теперь прогоняет edit через reject-фильтры до отдачи в renderer.
- Реализованы гейты: `whitespace-only`, `window-shape`, `pure-insertion-above-cursor`, `edit-volume`.
- Причина reject логируется.

Зачем:

- Плохая NES-правка хуже отсутствия подсказки.
- Гейты отсекают форматный шум, drift окна, низкоценные вставки выше курсора и слишком большие правки.

## P0-8. Prose-профиль

Сделано:

- `SweepRequestBuilder` определяет `fileMode` и для prose использует `editorProseWindow()`.
- Prose-окно расширяется до границ абзаца через пустые строки.
- В trimmer diagnostics отключены для `fileMode = 'prose'`.
- Каноничный формат prompt при этом сохраняется: file blocks, diff blocks, `original/current/updated`.

Зачем:

- Для markdown/typst/latex/plain text кодовые эвристики окна и diagnostics дают шум.
- Prose-режим сохраняет Sweep-формат, но использует текстовые границы вместо code-only окна.

## P1-4. Token-aware budget

Сделано:

- Добавлен `src/node/sweep/token-budget/token-counter.ts`.
- Добавлена зависимость `@xenova/transformers`.
- `SweepBackendService` создаёт lazy `QwenTokenCounter` и вызывает `ensureReady()` перед сборкой prompt.
- `trimSweepContext()` считает бюджет в токенах, а не в символах, с fallback `charTokenEstimate()` при сбое загрузки токенизатора.

Зачем:

- Sweep-модели основаны на Qwen, поэтому Qwen tokenizer ближе к реальному лимиту prompt, чем грубый char-budget.
- Fallback сохраняет работоспособность подсказок, если tokenizer не загрузился.

## Каноничный порядок prompt

Сделано:

- `buildSweepPrompt()` теперь собирает секции в порядке: широкий текущий файл → RAG neighbors → related files → `outline/` → `diagnostics/` → `output/` → diff blocks → `original/` → `current/` → `updated/`.
- `updated/` остаётся последним блоком, после него модель генерирует continuation.
- Stop tokens оставлены каноничными: `<|file_sep|>`, `<|endoftext|>`.

Зачем:

- Такой порядок ближе к training-format Sweep и уменьшает вероятность context drift.
- Финальная триада в конце prompt сохраняет основной next-edit сигнал.

## Сопутствующие изменения из `git status`

Изменённые source-файлы:

- `src/browser/preferences/preferences-schema.ts`
- `src/browser/sweep/data-formatting-layer/sweep-request-builder.ts`
- `src/browser/sweep/trigger-layer/sweep-controller.ts`
- `src/common/nes-types.ts`
- `src/common/sweep/logger.ts`
- `src/common/sweep/types.ts`
- `src/node/services/nes-backend-service.ts`
- `src/node/sweep/data-formatting-layer/context-trimmer.ts`
- `src/node/sweep/data-formatting-layer/file-blocks.ts`
- `src/node/sweep/model-call-layer/llama-sweep-client.ts`
- `src/node/sweep/model-call-layer/sweep-response-parser.ts`
- `src/node/sweep/prompt-creating-layer/sweep-prompt-builder.ts`
- `src/node/sweep/sweep-backend-service.ts`

Новые source-файлы:

- `src/common/sweep/original-window-reconstruction.ts`
- `src/common/sweep/profiles.ts`
- `src/node/sweep/model-call-layer/reject-gates.ts`
- `src/node/sweep/token-budget/token-counter.ts`

Изменены тесты и generated test build:

- `test/llama-nes-client.test.ts`
- `test/nes-prompt.test.ts`
- `test/nes-response-parser.test.ts`
- соответствующие файлы в `lib-test/**`

Изменены generated runtime build артефакты:

- соответствующие файлы в `smart-completions/lib/**`

Изменены зависимости и lock-файлы:

- `smart-completions/package.json`
- `package-lock.json`
- `node_modules/.package-lock.json`
- новые директории в `node_modules/**`, связанные с `@xenova/transformers` и его зависимостями.

Отдельно в `git status` есть `developer_rules/rules.md`: это обновление описания фактической реализации и Sweep prompt specification, а не runtime-фикс из `fixes.md`.
