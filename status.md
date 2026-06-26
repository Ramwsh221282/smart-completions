# Smart Completions Status

Дата фиксации: 2026-06-25

## Sweep NES: model-first refactor (2026-06-25)

Sweep-specific логика вынесена из legacy `nes-module` в model-first структуру:

- `src/common/sweep/` — Sweep-типы, логирование, edit-сигналы, retrieval-запросы, outline,
  related files, output filtering.
- `src/node/sweep/` — formatting, prompt creation, llama.cpp client, response parser,
  backend orchestrator.
- `src/browser/sweep/` — trigger layer, Sweep-owned edit history, context collector,
  Theia data sources, request builder.
- `src/browser/nes-render/` — общий model-independent NES View Zone renderer.
- `src/node/services/nes-backend-service.ts` и `src/browser/nes-module/nes-controller.ts`
  остались facade/router для Sweep и legacy Zeta-path.

Подтверждённые инварианты после переноса:

- Sweep prompts всё ещё в training-формате: без `context/*`, native `<|file_sep|>` blocks,
  recent edits как `{path}.diff`, diagnostics как `diagnostics/{file}`, финальная триада
  `original/` → `current/` → `updated/`, `updated/` замыкает prompt.
- Sweep logging идёт через `SweepLogger`, включая полный prompt в prompt-creating и model-call слоях.
- RAG retrieval query строится из edit-сигнала, не из слепого окна.
- `sweep-small` diagnostics injection живёт в Sweep path и остаётся вне editable target window.
- FIM path не получает `recentEdits`/`diagnostics`.

Проверки после refactor:

- Biome targeted lint: PASS (`npm run lint`).
- Isolated compile + unit suite: PASS (`90 tests / 80 pass / 0 fail / 10 gated-skip`).
- Full Theia typecheck: PASS (`tsc -p tsconfig.json --noEmit`).
- Declaration emit: PASS.

### Post-refactor battlefield matrix (NES + Embedding, FIM выключен)

Embedding granite-embedding-311M на `:8090`; NES на `:8000`; FIM выключен. Все связки
прошли `22/22` инвариантов на refactored Sweep path:

- sweep-default · lancedb — 22/22 (`2026-06-25T13-57-59-561Z__embed-granite-embedding-311M__db-lancedb__fim-none__nes-sweep-default`).
- sweep-default · chromadb — 22/22 (`2026-06-25T13-58-14-751Z__embed-granite-embedding-311M__db-chromadb__fim-none__nes-sweep-default`).
- sweep-small (+diagnostics) · lancedb — 22/22 (`2026-06-25T14-05-16-192Z__embed-granite-embedding-311M__db-lancedb__fim-none__nes-sweep-small`).
- sweep-small (+diagnostics) · chromadb — 22/22 (`2026-06-25T14-05-36-762Z__embed-granite-embedding-311M__db-chromadb__fim-none__nes-sweep-small`).

## Sweep NES: переход на training-формат блога Sweep (2026-06-25)

Промпт Sweep (`sweep-default`, `sweep-small`) переписан под нативный training-формат. Файл —
`src/node/nes-module/context-formation/builder.ts`, `buildSweepPrompt()`.

Изменения:
- Удалена захардкоженная инструкция `context/rules` и все `context/*` секции.
- RAG-соседи и связанные файлы → нативные блоки `<|file_sep|>{file_path}\n{content}` (Зона A).
- Outline / diagnostics / output → pseudo-files `<|file_sep|>outline|diagnostics|output/{...}` (Зона B).
- Recent changes → нативные `<|file_sep|>{path}.diff` с состояниями `original:`/`updated:`
  (`unifiedDiffToOriginalUpdated`); метки путей — workspace-relative (`recentEditsForPrompt`).
- diagnostics: pseudo-file `diagnostics/{file}` для обеих Sweep-моделей, фильтр только
  `error`/`warning`, `error` раньше `warning`, ≤20 маркеров, формат `Line N: message`.
- Зона D — обязательная триада `original/` → `current/` → `updated/`, всегда последние три блока
  именно в этом порядке; `updated/{file}` (с prefill, по умолчанию пустым) замыкает промпт —
  модель генерирует из него. Заголовки несут реальный диапазон строк `:{start}:{end}`.
- `original/` берётся из снимка окна до последней правки (`EditHistoryRecorder.getWindowBeforeLastEdit`);
  нет снимка — fallback на текущее окно.
- Бюджет токенов: триада не режется; порядок отбрасывания — output → outline → warnings →
  RAG/related → старые diff-блоки; errors не режутся.
- Parser поддерживает prefill (`prefill + ответ модели`), Zeta/Zeta 2.1 не затронуты.
- Плумбинг новых источников проброшен в `NesRequest`/builder/backend: `originalWindowText`,
  `windowStartLine`, `relatedFiles`, `outline`, `outputSnippets`, `prefill`.

Reranker по решению пользователя НЕ вводится: RAG остаётся на текущем hybrid retrieval
(vectors + BM25 + RRF). Фронтенд-источники Theia подключены best-effort: outline/LSP symbols,
search-in-workspace, output, call/type hierarchy и SCM dirty/co-changed file source. Точные recent
diffs по-прежнему берутся из `EditHistoryRecorder`, потому что generic SCM API не отдаёт diff.

Проверки: unit `90 tests / 80 pass / 0 fail / 10 gated-skip`; полный Theia typecheck `tsc --noEmit`
PASS; declaration emit PASS.

### Боевой прогон нового формата (NES + Embedding, FIM выключен)

Embedding granite-embedding-311M (dim 768) на `:8090`; NES на `:8000`; FIM не запускался.
Все связки с новыми plugin-source зонами — `22/22` инвариантов
(отчёты в `test_results/…__fim-none__nes-sweep-*`):

- sweep-default · lancedb — 22/22 (`2026-06-25T12-40-11-133Z__embed-granite-embedding-311M__db-lancedb__fim-none__nes-sweep-default`).
- sweep-default · chromadb — 22/22 (`2026-06-25T12-46-58-354Z__embed-granite-embedding-311M__db-chromadb__fim-none__nes-sweep-default`).
- sweep-small (+diagnostics) · lancedb — 22/22 (`2026-06-25T12-48-11-149Z__embed-granite-embedding-311M__db-lancedb__fim-none__nes-sweep-small`).
- sweep-small (+diagnostics) · chromadb — 22/22 (`2026-06-25T12-48-28-856Z__embed-granite-embedding-311M__db-chromadb__fim-none__nes-sweep-small`).

Подтверждено в артефактах:
- триада `original/`→`current/`→`updated/` — последние три блока, `updated/` замыкает промпт;
- отсутствуют legacy-секции (`context/rules`, `context/retrieval`, `context/diagnostics`,
  `recent_changes`, инструкция);
- recent change отрисован как `{path}.diff` с `original:`/`updated:`;
- diagnostics pseudo-file `diagnostics/user-service.ts` стоит ДО триады и НЕ внутри окна-цели
  (старый баг echo диагностик структурно исключён);
- outline pseudo-file, related file block и sanitized output pseudo-file проходят через реальный
  NES-промпт и стоят до триады;
- diff-query retrieval нашёл кросс-файловую зависимость;
- обе Sweep-модели валидно применили `fullName` → `displayName`, без протечки маркеров/секций.

## Боевой прогон матрицы (2026-06-25, живые llama.cpp)

Сервера: embedding `:8090` (CUDA0), NES `:8000` (CUDA0), FIM `:8070` (Vulkan0 / AMD RX 9060 XT).
Раннер `test/battlefield.integration.test.ts` поверх `test_battlefield/repo`; отчёты в
`test_results/`. Каждый прогон: чистое пересоздание БД → индекс → retrieval → FIM/NES no-RAG и
with-RAG. Все инварианты плагина прошли (отчёты — `test_results/<bundle>/report.md`):

- granite-embedding-311M (768) · lancedb · FIM granite-4.1-8b · NES sweep-default — 15/15.
- granite-embedding · lancedb · NES zeta-2.1 — 10/10 (нативный промпт/парсер Zeta 2.1 живьём:
  модель вернула `<|marker_1|>…<|user_cursor|>…<|marker_2|>`, парсер вырезал регион, правка
  `fullName`→`displayName` без протечки маркеров).
- granite-embedding · lancedb · NES sweep-small (+inject diag) — 10/10.
- jina-code-embeddings-1.5b (1536) · lancedb · FIM granite-4.1-8b · NES sweep-small — 15/15
  (embedding-модель свободная, БД пересоздана под другую размерность).
- jina-code-embeddings-1.5b · chromadb · FIM granite-4.1-8b · NES sweep-small — 15/15.
- jina · lancedb · FIM qwen2.5-coder-7B — 8/8 (live-проверка qwen FIM-шаблона).
- jina · lancedb · FIM deepseek-coder-6.7b — 8/8 (live-проверка deepseek FIM-шаблона).

NES diff-query во всех with-RAG прогонах нашёл кросс-файловую зависимость `user-service.ts` по
diff правки `types.ts`.

### Баг, найденный и исправленный боевым тестом

`sweep-small` inject-diagnostics: текст диагностик добавлялся ВНУТРЬ `current/`-окна, которое
модель переписывает, поэтому модель echo'ила его в предлагаемую правку (принятие правки вставило
бы текст диагностик в файл). Исправлено: диагностики вынесены в pseudo-file
`<|file_sep|>diagnostics/{file}` вне окна-цели. Добавлен инвариант (leak-проверка на
«Inline diagnostics near the cursor») в боевой раннер и юнит-тест.

## Доработки перед боевым тестированием (2026-06-25)

Реализована Часть 1 финального плана (`docs/test_model_matrix.md`):

1. NES retrieval-запрос строится из недавних правок (unified diff), а не из окружения курсора
   (`nesRetrievalQuery` в nes-builder, используется в `nes-backend-service`). Diff точнее находит
   кросс-файловые зависимости.
2. NES-промпт обрезается под окно модели (`buildNesPrompt` + `contextSize`). Приоритет
   сохранения: окно у курсора → свежие правки → диагностики (sweep-small) → RAG-соседи (режутся
   первыми). Пустое ядро → `overflow`, backend не делает подсказку.
3. Нативный промпт и парсер Zeta 2.1 (`modelId = 'zeta-2.1'`): SPM-формат, related files,
   `edit_history` с заголовками diff, target file, маркеры `<|marker_1|>…<|marker_2|>`,
   `<|user_cursor|>`. Парсер вырезает регион между маркерами.
4. Embedding-модель сделана свободной строкой (`EmbedModelId = string`); псевдонимы
   `nomic`/`granite` разворачиваются, любое другое имя уходит в запрос как есть. FIM-наполнение
   контекста оставлено как есть (prefix/suffix/native + RAG), без recentEdits/diagnostics.
5. `test_battlefield/repo` — синтетический workspace с кросс-файловыми зависимостями.
   `test_battlefield/repo` + `test_results/` готовы для матрицы.
6. Боевой раннер `test/battlefield.integration.test.ts` (гейт `SC_BATTLE_IT=1` + `SC_BATTLE_REPO`):
   чистое пересоздание БД → индекс → retrieval → FIM (no-RAG/with-RAG) → NES (no-RAG/with-RAG,
   diff-query) → отчёт в `test_results`.

Проверки: unit/typecheck — `tsc` тестов и `tsc --noEmit`/declaration-emit src проходят; 57 unit
pass, 0 fail (10 gated integration skip без живых серверов).

## Краткий итог

Baseline реализации `smart-completions` готов и проверен интеграционными тестами против живых
llama.cpp моделей: FIM (Granite 4.1 8B на :8080) и NES (Sweep2-7B на :8000), а также RAG поверх
реального ChromaDB. В ходе тестирования найдены и исправлены два FIM-бага.

## Интеграционное тестирование с живыми моделями (2026-06-25)

- FIM endpoint `:8080` = `granite-4.1-8b-Q8_0.gguf` (n_ctx=16384), NES endpoint `:8000` =
  `sweep2-7B-Q5_K_M.gguf` (n_ctx=8192). Оба отвечают на `/v1/completions`.
- Embeddings ни один сервер не отдаёт (`This server does not support embeddings`), поэтому RAG
  e2e проверен с детерминированным embed-дублёром поверх реального ChromaDB.
- Все интеграционные тесты идемпотентны; llama.cpp процессы не убиваются, ChromaDB поднимается на
  свободном порту и гасится в `finally`.

### Найденные и исправленные баги

1. FIM repo-формат с фиктивными слотами. `buildFimPrompt` всегда оборачивал Granite/Qwen в
   repo-структуру с заглушками `<|reponame|>workspace` / `<|filename|>current-file` даже без
   retrieval-соседей. На реальной Granite это давало мусор (например `"\n\`\`\`"`). Исправлено:
   repo-слоты заполняются только при наличии реальных соседей, иначе file-level FIM.
2. Line-режим возвращал пустую строку. Granite на части промптов выдаёт ведущий `\n`, а серверный
   стоп-токен `\n` обрывал генерацию до содержимого. Исправлено: `\n` убран из серверных стопов,
   в postprocess срезается ведущий перевод строки и берётся первая строка (multiline не затронут).
3. ChromaDB-стор ранжировал по L2 вместо cosine. Коллекция создавалась с дефолтным пространством
   Chroma (L2), хотя задумано cosine (как в LanceDB). На нормализованных векторах L2≈cosine, но
   нулевые/короткие векторы в L2 ложно оказываются «ближе» к запросу, всплывая в выдаче.
   Исправлено: коллекция создаётся с `configuration: { hnsw: { space: 'cosine' } }`.
4. FIM-вывод протекал markdown-ограждением. Granite с repo-контекстом иногда оборачивает инфилл
   в ` ``` `. Исправлено: postprocess снимает открывающее ` ```lang ` и обрезает на закрывающем
   ` ``` ` (для кода ограждение всегда мусор). Найдено реальным RAG→FIM прогоном.

### Полностью реальный пайплайн с эмбеддингами (granite-embedding-311M на :8090, dim=768)

- Тест `embedding-live-rag.integration.test.ts` (`SC_EMBED_IT=1`): реальные эмбеддинги через
  `LlamaEmbedClient` → индексация исходников в живой ChromaDB → семантический/гибридный retrieval →
  RAG→FIM (реальные соседи из ChromaDB кормят реальный Granite на :8080).
- Индексация `src/` реальными эмбеддингами: state=ready за ~3.8s.
- Retrieval точен: `crlf` → `crlf.ts`, `reciprocal rank fusion` → `hybrid-retriever.ts`,
  `postprocess FIM completion` → `postprocess.ts`, `parse NES completion` → `response-parser.ts`;
  чисто семантический `split source code into chunks per function and class` → `chunker.ts`.
- RAG→FIM: соседи `builder.ts` дали осмысленное `buildFimPrompt(input);` (после фикса — без ` ``` `).

### Индексация реального репозитория в ChromaDB (проверено)

- Тест `repo-index-chroma.integration.test.ts` (`SC_REPO_IT=1`, `SC_REPO_PATH=<repo>`): поднимает
  ChromaDB на свободном порту, индексирует реальный `smart-completions` (78 файлов, state=ready
  за ~3.5s), прогоняет реалистичные запросы и проверяет, что целевые файлы попадают в top-5.
- Примеры выдачи: `postprocessFimCompletion ...` → `postprocess.ts:10-31` (#1);
  `parseNesCompletion ...` → `response-parser.ts:17-31` (#1);
  `ChromaVectorStore ...` → `chromadb-store.ts:28-163` (top-5); `buildFimPrompt ...` → `builder.ts`.
- Эмбеддинги llama.cpp недоступны → вектора даёт детерминированный высокоразмерный stand-in
  (cosine ≈ лексическое пересечение); BM25-половина гибрида работает по реальному тексту чанков.

## Выполнено

- Исправлены комментарии в коде: запрещённых ссылок на `plan.md`, `AGENTS.md`, этапы/ветки/пререквизиты в `smart-completions/src`, `smart-completions/test` и `default.nix` не осталось.
- Реализован embedding-module: tree-sitter/prose chunking, LanceDB, ChromaDB, BM25, RRF hybrid retrieval, repo indexer/reconcile, `EmbeddingService`, backend RPC, frontend preferences/config sync/status/commands.
- Реализован FIM baseline: model-family prompt templates, repo slots для Qwen/OmniCoder/Granite, DeepSeek native FIM, semantic trim, RAW llama.cpp `/completions`, stop tokens, 503 retry, cancellation, postprocess, backend RPC, Monaco inline completions provider, code/prose gating, `Tab` accept.
- Реализован NES baseline: mandatory recent edit recorder, Sweep/Sweep-small/Zeta prompt builders, sweep-small inline diagnostics injection, RAG retrieval, RAW llama.cpp `/completions`, 503 retry, line-diff parser, backend RPC, frontend debounce trigger, coordination preferences, Monaco View Zone renderer, accept/dismiss/jumpOrAccept commands.
- Обновлены preferences для FIM, NES, coordination mode и embedding-инфраструктуры.
- Подключены frontend/backend DI-модули для FIM, NES и embedding RPC.
- Обновлены `package.json`, `package-lock.json`, `smart-completions/package.json`.
- Добавлен `apache-arrow@18.1.0`, чтобы `@lancedb/lancedb` корректно собирался в Theia bundle.
- Пересчитан `npmDepsHash` в `default.nix`.
- Обновлён `smart-completions/plan.md` под фактический статус.

## Проверки

- Runtime/unit/integration harness: `./node_modules/.bin/tsc -p test/tsconfig.json && node --test lib-test/test/*.test.js`.
- Результат runtime suite: 44 tests, 43 pass, 1 skipped.
- Typecheck harness: `./node_modules/.bin/tsc -p tsconfig.json --noEmit`.
- Результат typecheck: pass.
- ChromaDB infrastructure integration: `SC_CHROMA_IT=1 node --test lib-test/test/chromadb-store.integration.test.js`.
- Результат ChromaDB integration: pass, тест сам поднимает сервер, выполняет проверку и очищает инфраструктуру.
- Nix build: `NIXPKGS_ALLOW_INSECURE=1 nix-build -E 'let pkgs = import <nixpkgs> {}; in pkgs.callPackage ./default.nix {}' -A theia-desktop`.
- Результат Nix build: pass.
- Финальный Nix output: `/nix/store/vnam3249xmc83jxpd816i22vi6c3vdl8-theia-ide-desktop-1.72.3`.
- Полный gated прогон: `SC_FIM_IT=1 SC_NES_IT=1 SC_CHROMA_IT=1 SC_REPO_IT=1 SC_EMBED_IT=1 + URLs/SC_REPO_PATH node --test lib-test/test/*.test.js`.
- Результат gated прогона: 58 tests, 58 pass, 0 fail, 0 skipped (FIM :8080, NES :8000, embed :8090).
- FIM live (Granite :8080): file-level multiline, line mode, repo-context-with-neighbors — pass.
- NES live (Sweep :8000): edit из recent changes, диапазоны правок внутри окна — pass.
- ChromaDB e2e: store integration + EmbeddingService e2e + индексация реального репозитория — pass.

## Известные ограничения

- Большой чанк класса (жадное чанкование = класс целиком) при однотемном запросе проигрывает по
  BM25-нормализации длины коротким import/комментариям; реальный FIM/NES-запрос — фрагмент кода
  (многословный), где это не проявляется. Тесты используют реалистичные многословные запросы.
- Самоописывающие `*.test.ts` (с англоязычными именами тестов) конкурируют с исходниками за
  топик-запросы; для retrieval-демо индексируется `src/`.
- FIM/NES backend-сервисы (DI-обёртки uri→path + retrieval) покрыты unit-тестами с фейками и
  typecheck/Nix-сборкой; интеграционные тесты бьют по чистому пайплайну prompt → client → postprocess/parse.
- NES parser сейчас baseline: window rewrite превращается в один line-range edit; multi-region Zeta 2.1 parsing ещё не выделен в полноценную реализацию.
- UI конфигурационной панели ещё нет; настройки доступны через Theia preferences schema.
- Electron 39 помечен Nixpkgs как insecure/EOL, поэтому Nix build запускался с `NIXPKGS_ALLOW_INSECURE=1`.

## Следующие шаги

- Поднять локальные llama.cpp endpoints для выбранных FIM/NES/embedding моделей и выполнить smoke tests генерации.
- Проверить UX в реальном Theia Desktop: FIM ghost text, NES View Zone, keybindings, переключение coordination mode.
- Довести NES Zeta/Zeta 2.1 multi-region parsing и rendering при необходимости.
- Добавить конфигурационную панель для FIM/NES/embedding/vector DB настроек.
- Улучшить визуал NES View Zone: diff-превью, подсветка удаления/вставки, состояние pending/accepted/dismissed.
