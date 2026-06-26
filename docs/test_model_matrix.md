# Боевое тестирование плагина на разных моделях и параметрах запуска

Документ разделён на две части:

- **Часть 1 — План перед тестированием.** Доработки плагина и тестовой инфраструктуры,
  которые нужно завершить до боевого прогона, чтобы тест проверял именно механизм
  (context-formation FIM/NES + RAG), а не упирался в заведомые ограничения реализации.
- **Часть 2 — План тестирования.** Сам боевой прогон по матрице моделей.

**Главная цель всей части тестирования:** доказать, что механизм плагина (мозг) по работе с
FIM/NES и наполнению контекста работает корректно и без багов, а различия результатов зависят
ТОЛЬКО от качества подсказок самих FIM/NES моделей. Если инварианты плагина целы, а подсказка
слабая — это сторона модели, не баг плагина.

---

# Часть 1 — План перед тестированием

## 1.1 FIM: модель контекста зафиксирована как корректная

FIM наполняется так и менять это НЕ нужно:

- `prefix`;
- `suffix`;
- нативные FIM-токены модели (prefix/suffix/middle);
- `filePath` / `repoName` только для моделей с repo-context слотами;
- RAG-соседи только при `ragEnabled=true` и наличии repo-context слотов у модели.

В FIM НЕ добавляем `recentEdits` и `diagnostics`. Это контекст NES, а не FIM. Соответственно
`contextSources.recentEdits` и `contextSources.diagnostics` для FIM не реализуем как источники
prompt (preference может остаться, но FIM-наполнение от них не зависит).

## 1.2 NES: исправить источник retrieval-запроса

Сейчас:

```ts
query = windowText.slice(-prefixTailChars)
```

Должно быть (источник = недавние правки, unified diff):

```ts
query = recentEdits
  .slice(-N)
  .map(edit => edit.unifiedDiff)
  .join('\n\n')
  .slice(-prefixTailChars)
```

Причина: diff точнее описывает, что пользователь сейчас меняет, и лучше находит кросс-файловые
зависимости, чем окружение курсора. Это только замена строки формирования query перед
существующим retrieval (embedding + BM25 + RRF). Reranker не трогаем. `windowText` как query для
NES больше не основной (допустим только как явный fallback при пустом diff, но NES и так не
запускается без recentEdits).

## 1.3 NES: реализовать тримминг промпта по contextSize

`buildNesPrompt()` обязан учитывать окно модели (`NesConfig.contextSize`), т.к. модели имеют
ограниченный контекст.

Приоритет сохранения (что режем в первую очередь сверху вниз):

1. RAG-соседи — режем первыми и сильнее всего;
2. recentEdits — режем старые, сохраняем последние;
3. diagnostics (только sweep-small при `injectInlineDiagnostics`);
4. current editable window / region + cursor — режем в последнюю очередь.

Если даже обязательное ядро (current window + cursor) не помещается — лучше не делать подсказку,
чем слать переполненный/битый prompt.

## 1.4 NES: реализовать нативный промпт Zeta 2.1

Отдельный `modelId = 'zeta-2.1'` со своим builder и parser (не переиспользовать Zeta 2.0).

Нативные слоты Zeta 2.1 (заполняем только тем, на чём она обучалась):

- `<[fim-suffix]>` — текст после editable region;
- `<[fim-prefix]>` — начало prefix-stream;
- `<filename>related/file` — RAG-соседи как related files;
- `<filename>edit_history` — recentEdits в unified diff (с заголовками `---`/`+++`);
- `<filename>target_file` — текущий файл;
- `<|marker_1|> ... <|marker_2|>` — editable region;
- `<|user_cursor|>` — позиция курсора внутри region;
- `<[fim-middle]>` — место генерации.

Парсер ожидает вывод `<|marker_1|> ... <|marker_2|>` и заменяет editable region. Запрещены
выдуманные слоты (`retrieval`, `rules`, `diagnostics`, `repo`, произвольные metadata-блоки).

## 1.5 Embedding-модель: снять ограничение на nomic/granite

Сейчас `EmbedModelId = 'nomic' | 'granite'` и enum в preferences. Нужно разрешить ЛЮБУЮ
embedding-модель:

- модель задаётся строкой (имя для llama.cpp `/v1/embeddings`);
- не хардкодить enum;
- имя модели идёт в запрос как конфиг.

Изоляцию БД по embedding-модели на уровне плагина пока НЕ делаем (это отдельная задача).

## 1.6 Тестовый lifecycle векторных БД

Разные embedding-модели несовместимы (разные пространства и размерности — 768 / 896 / 1024).
Поэтому НА УРОВНЕ ТЕСТИРОВАНИЯ при смене embedding-модели обязательно:

- полностью пересоздать LanceDB;
- полностью пересоздать ChromaDB collection;
- заново проиндексировать `test_battlefield`;
- записать имя embedding-модели и размерность в отчёт;
- запретить reuse индекса между embedding-моделями.

## 1.7 test_battlefield

Синтетический workspace для боевых сценариев:

- code-сценарии FIM;
- prose-сценарии FIM (markdown/plaintext/latex);
- code-сценарии NES;
- prose-сценарии NES;
- файлы с кросс-файловыми зависимостями для RAG;
- сценарии recentEdits для NES (включая diff с символом, который ищется в другом файле);
- diagnostics-сценарии для sweep-small.

## 1.8 test_results

```text
test_results/
  <run-id>__embed-<embed>__db-<db>__fim-<fim>__nes-<nes>/
    report.md
    plugin_tests.log
    endpoints.json
    embedding_index_report.json
    retrieval_results.json
    no_rag/
      fim_results.json
      nes_results.json
      prompts/
      raw_responses/
    with_rag/
      fim_results.json
      nes_results.json
      prompts/
      raw_responses/
    artifacts/
```

---

# Часть 2 — План тестирования

## 2.1 Фиксированная инфраструктура

| Сервис | Порт | Режим |
|---|---|---|
| Embedding | `:8090` | `--embedding` (любая embedding-модель) |
| Next Edit (NES) | `:8000` | completions |
| FIM autocomplete | `:8070` | completions |

- llama.cpp base URL всегда с `/v1`.
- Каталог моделей: `/home/ramwsh/llama_models/`.
- GPU: FIM → `vulkan0`, NES → `cuda0`, embedding → `cuda0`.
- ChromaDB в тестах — на свободном порту (не `:8000`), гасится в `finally`.
- LanceDB — embedded во временном каталоге, очищается после теста.
- Процессы llama.cpp в тестах не убиваются.

## 2.2 Поддерживаемые модели (по prompt/template плагина)

FIM:

- `qwen2.5-coder` → `/home/ramwsh/llama_models/qwen25/Qwen2.5-Coder-*`
- `deepseek-coder` → `/home/ramwsh/llama_models/deepseek/deepseek-coder-*-base*`
- `omnicoder` → `/home/ramwsh/llama_models/qwen35/omnicoder-9b-q4_k_m.gguf`
- `granite-4.1-8b` → `granite-4.1-8b-Q6_K/Q8_0`
- `granite-4.1-3b` → `granite-4.1-3b-Q6_K/Q8_0`

NES:

- `sweep-default` → `sweep/sweep2-7B-Q5_K_M.gguf`
- `sweep-small` → `sweep/sweep-1.5B-Q8_0.gguf`, `sweep/sweep-0.5B-Q8_0.gguf`
- `zeta` → `zed-industries_zeta-2-Q6_K/Q5_K_M.gguf`
- `zeta-2.1` → `zeta-2.1.Q8_0/Q6_K/Q5_K_S.gguf` (после native integration из 1.4)

Embedding (любая, ось матрицы):

- `granite-embedding-311M-multilingual-r2-Q8_0`
- `jina-code-embeddings-1.5b-Q8_0`
- `jina-code-embeddings-0.5b-Q8_0`
- `embeddinggemma-300M-Q8_0`

Неподдерживаемые локальные GGUF игнорируются.

## 2.3 Два режима для каждой FIM/NES модели

Режим 1 — без RAG (`ragEnabled=false`): embedding/retrieval не участвуют; FIM = prefix/suffix +
native slots; NES = current window + recentEdits (+ diagnostics для sweep-small).

Режим 2 — с RAG (`ragEnabled=true`): embedding поднят, LanceDB/ChromaDB чисто пересозданы,
`test_battlefield` переиндексирован, retrieval-соседи реально попали в prompt.

## 2.4 Оси матрицы

- embedding-модель (с полным пересозданием БД при смене);
- vector DB: LanceDB и ChromaDB;
- режим RAG: off / on;
- FIM-модель / NES-модель.

## 2.5 FIM test flow

Для каждой FIM-модели: no-RAG сценарии; with-RAG сценарии по каждой embedding-модели и DB.
Проверки-инварианты:

- нет протечки спец-токенов (`<|fim_*|>`, `<|repo_name|>`, `<|file_sep|>`, `<|filename|>`,
  `<|reponame|>`, `<|endoftext|>`, `<|end_of_text|>`, deepseek-токены);
- нет markdown-ограждения ` ``` `;
- line/multiline/block отрабатывают корректно;
- CRLF нормализован;
- semantic trim не ломает FIM-структуру;
- нет переполнения сервера;
- repo-формат только при реальных соседях.

Качество no-RAG vs with-RAG — мягкая метрика.

## 2.6 NES test flow

Для каждой NES-модели: no-RAG; with-RAG по каждой embedding-модели и DB. recentEdits всегда
обязательны; diagnostics — только sweep-small. Проверки-инварианты:

- TextEdit валиден, диапазоны внутри окна;
- нет протечки маркеров/cursor (`<|cursor|>`, `<<<<<<<`, `=======`, `>>>>>>>`, `<|marker_*|>`,
  `<|user_cursor|>`);
- `NO_EDITS`/пусто → нет правки; пустые recentEdits → нет вызова;
- prompt trim по contextSize не переполняет окно;
- `finish_reason: length` не даёт битой правки;
- retrieval-query для NES берётся из recentEdits diff (см. 1.2);
- Zeta 2.1 — native marker parser, native slots.

## 2.7 Проверка diff-based retrieval (NES + RAG)

- сценарий, где `windowText` малоинформативен;
- recentEdits содержит изменяемое имя функции/типа/символа;
- зависимость лежит в другом файле `test_battlefield`;
- retrieval находит зависимость ИМЕННО по diff;
- найденные соседи попали в NES prompt;
- `ragEnabled=false` не вызывает retrieval;
- `ragEnabled=true` использует diff-query.

## 2.8 Критерии pass/fail

Баг плагина:

- crash/исключение;
- невалидная структура prompt;
- переполнение контекста;
- протечка спец-токенов в output;
- невалидный NES TextEdit;
- RAG-контекст не попал в prompt при `ragEnabled=true`;
- no-RAG случайно использовал retrieval;
- NES with-RAG использует windowText вместо recentEdits;
- БД переиспользована после смены embedding-модели;
- Zeta 2.1 prompt заполнен не native slots;
- `finish_reason: length` приводит к битой правке.

Не баг плагина (сторона модели):

- слабый код / бесполезная, но валидная правка;
- RAG не улучшил качество, хотя pipeline корректен;
- мелкая модель хуже крупной при одинаковом контексте.

## 2.9 Отчёт (на каждую связку в test_results)

Модели и параметры llama.cpp; embedding dimension; vector DB; статус индексации; retrieval top-N;
FIM no-RAG/with-RAG; NES no-RAG/with-RAG; статус инвариантов; заметки качества; raw prompts;
raw responses; latency.

## 2.10 Команды запуска

Запуск из `/home/ramwsh/llama_models`.

Embedding (`:8090`, любая модель — пример granite):

```bash
llama-server --model embedding/granite-embedding-311M-multilingual-r2-Q8_0.gguf \
  --embedding --n-gpu-layers 99 --split-mode none --device cuda0 --port 8090
```

FIM (`:8070`, vulkan0 — пример granite-8b):

```bash
llama-server --model granite-4.1-8b-Q8_0.gguf \
  --n-gpu-layers 99 --split-mode none --device vulkan0 \
  --ctx-size 16384 --batch-size 512 --ubatch-size 512 \
  --cache-type-k q8_0 --cache-type-v q8_0 --host 127.0.0.1 --port 8070 --threads 4
```

NES (`:8000`, cuda0 — пример sweep-default):

```bash
llama-server -m sweep/sweep2-7B-Q5_K_M.gguf --port 8000 --device CUDA0 --gpu-layers all \
  --flash-attn on --ctx-size 8192 --temp 0.0 --n-predict 512 --parallel 1 --poll 0 \
  --ubatch-size 2048 --cache-reuse 256 --spec-type ngram-simple --spec-draft-n-max 64
```

Стресс-варианты: low-ctx (`--ctx-size 4096`) для проверки тримминга, low-npredict
(`--n-predict 64`) для проверки `finish_reason: length`.
