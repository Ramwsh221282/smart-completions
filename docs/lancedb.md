# LanceDB — сборка (napi) и подключение

LanceDB используется как **встроенное (embedded)** векторное хранилище. Пакет `@lancedb/lancedb`
— нативный аддон на **napi-rs (N-API)**. N-API ABI-стабилен между версиями Node и Electron, то
есть prebuilt-бинарь, как правило, грузится в Electron-бэкенде без перекомпиляции (в отличие от
старых nan/V8-аддонов вроде node-pty).

## 1. Зависимость
`smart-completions/package.json`:
```json
"dependencies": { "@lancedb/lancedb": "^0.x" }
```
`@lancedb/lancedb` тянет платформенный prebuilt (`@lancedb/lancedb-linux-x64-gnu` и т.п.).

## 2. Где живут данные
Файлы LanceDB кладём в backend-доступную директорию хранилища воркспейса (Node fs), напр.
`<workspaceStorage>/smart-completions/lancedb`. Таблица на коллекцию чанков; идемпотентный
upsert по `id = md5(file_path:start_line:end_line)`.

## 3. Подключение в коде (backend, node/)
Реализация в `node/embedding-module/vector-store/lancedb-store.ts` за интерфейсом
`vector-store/iface.ts` (общий с chromadb-store). Псевдокод:
```ts
import * as lancedb from '@lancedb/lancedb';
const db = await lancedb.connect(dataDir);
const tbl = await db.openTable('chunks').catch(() => db.createTable('chunks', rows));
await tbl.add(rows);                                  // {id, vector, text, file_path, ...}
const hits = await tbl.search(queryVector).limit(2 * topN).toArray();
// FTS (Tantivy) для BM25-части гибрида:
await tbl.createIndex('text', { config: lancedb.Index.fts() });
const lex = await tbl.search(queryText, 'fts').limit(2 * topN).toArray();
```
Гибрид (vector + FTS) сливается через RRF (k=60) в `retriever/hybrid-retriever.ts`.

## 4. Сборка под Nix (`default.nix`)
`buildNpmPackage` с `npm_config_build_from_source = "true"` может пытаться собрать из исходников.
Для LanceDB предпочтителен **prebuilt**. План действий (в `preBuild`, по образцу node-pty/electron):
1. Убедиться, что platform-prebuilt (`@lancedb/lancedb-linux-x64-gnu`) присутствует в
   `node_modules` после `npm ci`.
2. Если требуется — закрепить `.node`-бинарь в ожидаемом пути (как делается для `pty.node`).
3. НЕ заставлять build-from-source для этого пакета, если prebuilt валиден (избегаем тяжёлой
   Rust-сборки в Nix-песочнице).
4. После добавления зависимостей **пересчитать `npmDepsHash`**: выставить `lib.fakeHash`, собрать,
   взять корректный хеш из ошибки, подставить.

## 5. Проверка загрузки в Electron-бэкенде
N-API → ожидаем загрузку без ребилда. Проверка: на старте backend-сервиса в dev-режиме
залогировать `require('@lancedb/lancedb')` успех/ошибку. Если бинарь не грузится под
`electron_39` — рассмотреть `electron-rebuild`/build-from-source как fallback (Rust toolchain в
`nativeBuildInputs`).

## 6. Статус
До стабилизации LanceDB-сборки **дефолтное хранилище для разработки — ChromaDB через pipx**
(см. `infra.md`). LanceDB-store реализуется и подключается следующим, без блокировки FIM/NES.
