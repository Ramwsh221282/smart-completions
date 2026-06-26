# Идея: миграция ядра smart-completions в Rust/Zig бинарник

## Суть

После стабилизации логики на TypeScript — перенести «горячую» часть плагина
в отдельный нативный бинарник (Rust или Zig). Задача Theia IDE / Node.js backend
после миграции: только передача данных из редактора в бинарник и обратно.

## Что переезжает в бинарник

- **llama.cpp** — вызов через C API напрямую (без HTTP-сервера, без round-trip)
- **Tree-sitter** — нативный, не WASM, для CodeGraph-экстрактора
- **LanceDB** — уже Rust внутри, просто линкуется
- **BM25 + RRF** — in-memory индекс, без GC давления
- **Prompt building / token trimming / diff-блоки** — строковые операции; latency мала, но **memory overhead реальный**: V8 хранит строки в UTF-16 (×2 байта), промежуточные аллокации при конкатенации летят в GC. В Rust — один pre-allocated `Vec<u8>`, нет GC, нет копий.
- **better-sqlite3** — уже нативный, просто линкуется

## Архитектура после миграции

```
Theia IDE (Electron)
  └─ Node.js backend (тонкий прокси, никакой бизнес-логики)
       └─ Unix socket (length-prefixed frames, streaming)
            └─ smart-completions-core (Rust/Zig)
                 ├─ Tree-sitter (нативный)
                 ├─ LanceDB
                 ├─ BM25 + RRF
                 ├─ better-sqlite3 (CodeGraph)
                 ├─ Prompt builder / token trimmer
                 └─ llama.cpp (C API, streaming tokens)
```

## IPC протокол

**Не HTTP** — Unix socket со streaming:

```
Node → Unix socket (length-prefixed frames) → бинарник
                                                   ↓
                                           llama.cpp C API (токены по мере генерации)
                                                   ↓
Node ← token chunks ←──────────────────────────────┘
```

- Протокол: `u32 length + msgpack / flatbuffers payload`
- Минимум сериализации, нет text-parsing, нет HTTP headers
- Токены стримятся по мере генерации — View Zone можно показывать не дожидаясь `max_tokens`

## Что остаётся в Node.js / TypeScript навсегда

- Вся Theia IDE интеграция (Monaco, DI, RPC, preferences, commands, View Zone renderer)
- Сбор сигналов с редактора (edit history, diagnostics, outline, SCM)
- Координация FIM/NES (дебаунс, режимы)
- Передача данных между Theia и бинарником

## Порядок

1. Сейчас: зафиксировать всю логику на TypeScript (Sweep → Zeta → FIM)
2. После стабилизации: API между Node-слоем и «ядром» выкристаллизуется естественно
3. Переписывание в Rust/Zig будет механическим переводом, а не поиском архитектуры
4. IPC-протокол — самая важная граница, проектировать с умом

## Статус

Идея отложена. Вернуться после того как все модули (Sweep, Zeta, FIM) доведены
до production-ready состояния на TypeScript.
