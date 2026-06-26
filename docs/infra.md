# Локальная инфраструктура (llama.cpp + ChromaDB)

Вся инфраструктура локальная. Плагин URL-driven: в настройках указываются полные URL'ы
эндпоинтов. Ничего, кроме плагина, не собирается в Nix — серверы поднимаются отдельно.

## 1. ChromaDB через pipx
ChromaDB — серверное хранилище; JS-клиент `chromadb` работает только по HTTP к запущенному
серверу.
```bash
pipx install chromadb           # или: pipx run --spec chromadb chroma run --path ./chroma-data
chroma run --host 127.0.0.1 --port 8001 --path ~/.local/share/smart-completions/chroma
```
Настройка плагина: `smart-completions.embedding.chromaUrl = http://127.0.0.1:8001`,
`smart-completions.embedding.vectorDb = chromadb`.

Плагин при `vectorDb=chromadb` обращается к серверу через `chromadb` (HTTP-клиент), создаёт
коллекцию `smart_completions_chunks` (cosine), upsert по идемпотентному id
`md5(file_path:start_line:end_line)`. BM25-часть гибрида плагин считает сам
(`vector-store/bm25-index.ts`), слияние RRF — в `retriever/hybrid-retriever.ts`.

## 2. llama.cpp инстансы
Раздельные инстансы под FIM / NES / embedding (раздельные нужны для parallel-режима координации
и разных моделей). Пример:
```bash
# FIM (RAW /completions)
llama-server -m Qwen2.5-Coder-1.5B-Q5_K_M.gguf  --host 127.0.0.1 --port 8000 -c 8192
# NES
llama-server -m sweep-next-edit-1.5B-Q5_K_M.gguf --host 127.0.0.1 --port 8010 -c 8192
# Embedding (--embeddings)
llama-server -m nomic-embed-text-v1.5.gguf --embeddings --host 127.0.0.1 --port 8020
```
Настройки плагина:
- `smart-completions.fim.llamaUrl = http://127.0.0.1:8000`
- `smart-completions.nes.llamaUrl = http://127.0.0.1:8010`
- `smart-completions.embedding.llamaUrl = http://127.0.0.1:8020`

## 3. Замечания
- FIM использует **RAW** `POST {llamaUrl}/completions` (поле `prompt`), не chat.
- Эмбеддинги: `POST {llamaUrl}/embeddings` (OpenAI-совместимо) или `/embedding` (нативный
  llama.cpp) — клиент поддержит оба.
- Стоп-токены, температура, нормализация CRLF→LF задаются плагином в model-call слое.
- compose.yaml намеренно НЕ шипим: инфраструктура поднимается вручную (pipx/llama-server).
