# Локальная инфраструктура (llama.cpp + ChromaDB)

Вся инфраструктура локальная. Ничего, кроме плагина, не собирается в Nix — серверы поднимаются отдельно. Настоящий документ описывает правила и шаблоны (карту) bash-команд запуска моделей для боевого тестирования, с упором на **выжимание максимума из моделей**.

# ВАЖНО

## МАППИНГ ПО ДЕВАЙСАМ (ВИДЕОКАРТАМ ОБЯЗАТАЛЕН И СТРОГ)

FIM модели запускаются на GPU Radeon RX 9060 XT
NES модели запускаются на GPU RTX 5070
EMBEDDING модели запускаются на GPU RTX 5070
RERANKING модели запускаются на GPU RTX 5070

## 0. Каталог моделей

Все GGUF лежат в `~/llama_models/` (= `/home/ramwsh/llama_models/`), разложены по типам:

```
~/llama_models/
├── sweep/        # NES (sweep)
├── qwen25/       # FIM (Qwen2.5-Coder)
├── rerankers/    # реранкинг
└── embedding/    # эмбеддинги
```

Для краткости в шаблонах используется переменная:

```bash
export LM=~/llama_models
```

## 1. llama.cpp инстансы

### Привязки к портам

| Порт | Назначение |
|---|---|
| 8010 | NES (sweep/zeta) |
| 8020 | FIM |
| 8030 | реранкинг |
| 8040 | эмбеддинги |

Раздельные инстансы под FIM / NES / embedding / reranking обязательны — они нужны для parallel-режима координации разных моделей (каждая модель в своём процессе на своём порту).

### Базовый набор флагов производительности

Применяется ко всем инстансам (вынесен один раз, чтобы не дублировать в каждом шаблоне):

```bash
# GPU-набор (выжимаем максимум; по умолчанию в шаблонах ниже)
PERF_GPU="-ngl 99 -fa on --cache-type-k q8_0 --cache-type-v q8_0 --mlock --no-mmap"
```

Что и зачем (это и есть то, что реально «двигает стрелку»):
- `-ngl 99` — отгрузить все слои на GPU (для CPU-only убрать).
- `-fa on` — flash-attention: меньше памяти, быстрее. На старых сборках просто `-fa`.
- `--cache-type-k q8_0 --cache-type-v q8_0` — квантование KV-кэша: позволяет уместить большее контекстное окно почти без потери качества (квант V требует flash-attn). Если VRAM в избытке и нужен абсолютный максимум качества KV — убрать (останется f16).
- `--mlock` — залочить веса в RAM (без свопа).
- `--no-mmap` — грузить модель целиком в память (чуть быстрее инференс, больше RAM).
- Continuous batching включён по умолчанию; отдельный `--parallel` не нужен (плагин шлёт по одному запросу на канал).

---

## 2. Карта шаблонов команд

### NES (порт 8010)

NES-вывод **сильно перекрывается с входным окном** (модель копирует код и меняет небольшой фрагмент). Это идеальный случай для **n-gram self-speculative decoding** — драфт строится из самого контекста, без отдельной draft-модели, ускорение без потери качества (верификация сохраняет распределение модели). Поэтому для sweep включаем ngram-спекуляцию.

Контекст — **по максимуму для каждой модели sweep** (это контекст, на котором модель обучалась; больше брать нельзя — деградирует): `sweep2-7B` → 32768, `sweep-1.5B`/`sweep-0.5B` → 8192.

Шаблон:

```bash
llama-server -m <model.gguf> --host 127.0.0.1 --port 8010 \
  -c <ctx> $PERF_GPU \
  --spec-default
```

`--spec-default` включает n-gram спекуляцию (ngram-mod) с разумными дефолтами. **Флаги спекуляции переименовывались между сборками llama.cpp** (legacy `--draft-max`/`--draft-min` удалены), поэтому для тонкой настройки сверься с `llama-server --help | grep -i spec`. Явная форма с тюнингом:

```bash
  --spec-type ngram-mod --spec-draft-n-max 64 --spec-ngram-mod-n-match 24
```

Конкретные команды:

```bash
# sweep2-7B — максимальный контекст 32768
llama-server -m $LM/sweep/sweep2-7B-Q5_K_M.gguf --host 127.0.0.1 --port 8010 \
  -c 32768 $PERF_GPU --spec-default

# sweep-1.5B — контекст 8192
llama-server -m $LM/sweep/sweep-1.5B-Q8_0.gguf --host 127.0.0.1 --port 8010 \
  -c 8192 $PERF_GPU --spec-default

# sweep-0.5B — контекст 8192
llama-server -m $LM/sweep/sweep-0.5B-Q8_0.gguf --host 127.0.0.1 --port 8010 \
  -c 8192 $PERF_GPU --spec-default
```

Температура (0, greedy), seed, стоп-токены (`<|file_sep|>`, `<|endoftext|>`), `cache_prompt:true` задаются **плагином** в model-call слое — на сервере не дублируются.

### FIM (порт 8020)

Модели Qwen2.5-Coder. **Контекстные окна подняты** с прежних 8192 до нативных **32768** (Qwen2.5-Coder нативно поддерживает 32768; это 4× к прошлому значению и существенно больше контекста для FIM).

Шаблон:

```bash
llama-server -m <model.gguf> --host 127.0.0.1 --port 8020 \
  -c 32768 $PERF_GPU
```

Конкретные команды:

```bash
# 0.5B
llama-server -m $LM/qwen25/Qwen2.5-Coder-0.5B-Q8_0.gguf --host 127.0.0.1 --port 8020 -c 32768 $PERF_GPU
# 1.5B
llama-server -m $LM/qwen25/Qwen2.5-Coder-1.5B.Q8_0.gguf --host 127.0.0.1 --port 8020 -c 32768 $PERF_GPU
# 3B
llama-server -m $LM/qwen25/Qwen2.5-Coder-3B-Q8_0.gguf  --host 127.0.0.1 --port 8020 -c 32768 $PERF_GPU
# 7B
llama-server -m $LM/qwen25/Qwen2.5-Coder-7B.Q8_0.gguf  --host 127.0.0.1 --port 8020 -c 32768 $PERF_GPU
# 14B
llama-server -m $LM/qwen25/Qwen2.5-Coder-14B-Q6_K.gguf --host 127.0.0.1 --port 8020 -c 32768 $PERF_GPU
```

FIM-спекуляция: для FIM ngram-выигрыш можно добавить `--spec-default` и сравнить на практике.

### Embeddings (порт 8040)

Шаблон (`--embedding`; pooling берётся из метаданных GGUF — указывать не нужно, если эндпоинт не отдаёт нули):

```bash
llama-server -m <model.gguf> --host 127.0.0.1 --port 8040 \
  --embedding -c <ctx> -b <ubatch> -ub <ubatch> $PERF_GPU
```

Важная особенность эмбеддингов: **`-b` (batch) должен быть равен `-ub` (ubatch)** и не меньше длины самого длинного входного чанка — иначе llama.cpp кидает assertion на эмбеддинг-задачах. Поэтому batch=ubatch и ≥ размера чанка.

Конкретные команды:

```bash
# granite-embedding-311M (ctx 8192)
llama-server -m $LM/embedding/granite-embedding-311M-multilingual-r2-Q8_0.gguf \
  --host 127.0.0.1 --port 8040 --embedding -c 8192 -b 8192 -ub 8192 $PERF_GPU

# jina-code-embeddings-1.5b (ctx 8192) — заточен под код
llama-server -m $LM/embedding/jina-code-embeddings-1.5b-Q8_0.gguf \
  --host 127.0.0.1 --port 8040 --embedding -c 8192 -b 8192 -ub 8192 $PERF_GPU

# jina-code-embeddings-0.5b (ctx 8192)
llama-server -m $LM/embedding/jina-code-embeddings-0.5b-Q8_0.gguf \
  --host 127.0.0.1 --port 8040 --embedding -c 8192 -b 8192 -ub 8192 $PERF_GPU

# embeddinggemma-300M (ctx 2048)
llama-server -m $LM/embedding/embeddinggemma-300M-Q8_0.gguf \
  --host 127.0.0.1 --port 8040 --embedding -c 2048 -b 2048 -ub 2048 $PERF_GPU
```

Если эндпоинт вернул нулевые векторы — добавить явный `--pooling mean` (или `last`, в зависимости от модели). Смена эмбеддера = **переиндексация репозитория** (векторное пространство несовместимо между моделями).

### Rerankers (порт 8030)

Шаблон (обязательны `--reranking --pooling rank`; `--embedding` тоже включается — так требуют reranker-модели; эндпоинт `/v1/rerank`):

```bash
llama-server -m <model.gguf> --host 127.0.0.1 --port 8030 \
  --reranking --pooling rank --embedding -c <ctx> $PERF_GPU
```

Конкретные команды:

```bash
# Qwen3-Reranker-0.6B — instruction-aware (инструкция кладётся ВНУТРЬ поля query)
llama-server -m $LM/rerankers/Qwen3-Reranker-0.6B.Q8_0.gguf \
  --host 127.0.0.1 --port 8030 --reranking --pooling rank --embedding -c 32768 $PERF_GPU

# bge-reranker-v2-m3 — быстрый single-forward, без инструкций (ctx 8192)
llama-server -m $LM/rerankers/bge-reranker-v2-m3-Q8_0.gguf \
  --host 127.0.0.1 --port 8030 --reranking --pooling rank --embedding -c 8192 $PERF_GPU

# jina-reranker-v3 — сильный на коде (ctx 8192)
llama-server -m $LM/rerankers/jina-reranker-v3-Q8_0.gguf \
  --host 127.0.0.1 --port 8030 --reranking --pooling rank --embedding -c 8192 $PERF_GPU
```

Особенности reranker'а:
- Дёргать **`/v1/rerank`**, не `/v1/embeddings` (для reranker-моделей embeddings вернёт нули).
- Qwen3-Reranker: отдельного поля инструкции в API нет — rerank-шаблон зашит в GGUF, инструкция передаётся **префиксом внутри `query`**: `"Instruct: <NES-инструкция>\nQuery: <edit-signal>"`.
- Плагин держит runtime-страховку `looksBroken`: вырожденные скоры (все ≈0 / |score| < 1e-10) → fail-open на RRF-порядок.
- Первый вызов холодной модели может занять секунды (warmup) — плагин прогревает в `configure()`.

---

## 3. Настройки плагина

Соответствуют таблице портов (раздел 1):

```
smart-completions.nes.llamaUrl       = http://127.0.0.1:8010
smart-completions.fim.llamaUrl       = http://127.0.0.1:8020
smart-completions.reranking.llamaUrl = http://127.0.0.1:8030
smart-completions.embedding.llamaUrl = http://127.0.0.1:8040
```

## 4. Примечание:

- FIM использует **RAW** `POST {llamaUrl}/completions` (поле `prompt`), не chat.
- Стоп-токены, температура (NES — 0/greedy), нормализация CRLF→LF задаются плагином в model-call слое.