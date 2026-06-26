# Спецификация: удаление телеметрии из smart-completions

Полностью убрать систему агрегации телеметрии NES (sink, эмиттеры, запись событий, wire-format `meta` в ответе, команды). Разработка соло, проверка на практике — агрегированные метрики не нужны и создают лишний оверхед.

## Принцип разделения

Удаляется **агрегация и передача метрик**, сохраняется **отладочная информация в логах**. Это важная граница: ты проверяешь работу «на опыте», читая консоль-логи. Эти логи (и поля, что их питают) — не оверхед, а твой инструмент отладки. Тесты подтверждают границу: `parsed.status/rejectReason` и `built.promptTokens` покрыты тестами и остаются.

### Что УДАЛЯЕТСЯ (агрегация + wire-format)

- `SweepTelemetry` sink целиком.
- Эмиттеры `onDidShow/onDidAccept/onDidDismiss` в рендерере + флаг `accepting`.
- Вызовы `recordPredicted/recordShown/recordAccepted/recordDismissed/recordStale`.
- Команды `NesTelemetryDumpCommand`, `NesTelemetryResetCommand`.
- DI-binding `SweepTelemetry`.
- `NesResponseMeta`, `NesResponseStatus`, поля `meta` и `requestId` в **ответах** (`NesResponse`, `SweepResponse`).
- `editLineCount`-хелпер и сборка `meta` в backend.

### Что СОХРАНЯЕТСЯ (load-bearing / отладка / тесты)

- `isVisible()` в рендерере — используется `nes-priority` (FIM уступает NES).
- `parsed.updatedWindow` — используется syntax-гейтом.
- `parsed.status` / `parsed.rejectReason` в `ParsedSweepCompletion` — покрыты тестами, питают backend-логи «почему нет правки».
- `BuiltSweepPrompt.promptTokens` / `tokenMode` / `contextProfile` — покрыты тестами, питают лог «Sweep prompt built». Твой фикс двойной токенизации остаётся в силе и держит `promptTokens` дешёвым.
- `requestId` в **запросах** (`NesRequest`, `SweepRequest`) — корреляция backend-логов; не оверхед.
- Все `LOG.info/debug` — не трогаются.

---

## Правки по файлам

### 1. УДАЛИТЬ файл целиком

```
src/browser/sweep/telemetry/sweep-telemetry.ts
```
(При желании удалить и пустую директорию `src/browser/sweep/telemetry/`.)

### 2. `src/browser/smart-completions-frontend-module.ts`

Удалить импорт (строка 21) и binding (строка 47):

```ts
import { SweepTelemetry } from './sweep/telemetry/sweep-telemetry';   // ← удалить
// ...
bind(SweepTelemetry).toSelf().inSingletonScope();                     // ← удалить
```

### 3. `src/browser/commands.ts`

Удалить импорт (строка 8), оба объявления команд (строки 40–47), inject (строка 56) и регистрации (строки 71–75):

```ts
import { SweepTelemetry } from './sweep/telemetry/sweep-telemetry';   // ← удалить

export const NesTelemetryDumpCommand: Command = { ... };              // ← удалить блок
export const NesTelemetryResetCommand: Command = { ... };             // ← удалить блок

@inject(SweepTelemetry) private readonly telemetry!: SweepTelemetry;  // ← удалить

registry.registerCommand(NesTelemetryDumpCommand, { ... });           // ← удалить
registry.registerCommand(NesTelemetryResetCommand, { ... });          // ← удалить
```

Проверить: если после удаления inject класс команд больше ничего не инжектит — убрать лишний конструктор/декоратор по ситуации.

### 4. `src/browser/sweep/trigger-layer/sweep-controller.ts`

Удалить импорт (15), поле inject (33–34), три подписки в `onStart` (62–64), `recordPredicted` (199), `recordStale` (202), и поправить лог на строке 208 (он читает `response.meta`).

```ts
import { SweepTelemetry } from '../telemetry/sweep-telemetry';        // ← удалить

@inject(SweepTelemetry) private readonly telemetry!: SweepTelemetry;  // ← удалить (с комментарием)

// в onStart() — удалить три строки:
this.toDispose.push(this.renderer.onDidShow(() => this.telemetry.recordShown()));    // ← удалить
this.toDispose.push(this.renderer.onDidAccept(() => this.telemetry.recordAccepted()));// ← удалить
this.toDispose.push(this.renderer.onDidDismiss(() => this.telemetry.recordDismissed()));// ← удалить

// в trigger() — удалить:
this.telemetry.recordPredicted(response);                            // ← удалить (строка 199)

// блок stale упростить: было
if (source.token.isCancellationRequested || model.getVersionId() !== version) {
    if (model.getVersionId() !== version) {
        this.telemetry.recordStale();                                // ← удалить только эту строку
    }
    LOG.info('Sweep trigger produced stale edit', { ... });
    return;
}
```

Лог на строке 208 (`response.meta.status` / `response.meta.rejectReason` больше не существуют):

```ts
// было:
LOG.info('Sweep trigger produced no visible edit', { status: response.meta.status, rejectReason: response.meta.rejectReason, edits: response.edits.length });
// стало:
LOG.info('Sweep trigger produced no visible edit', { edits: response.edits.length });
```
(Причина «почему нет правки» по-прежнему логируется на backend-стороне из `parsed.status/rejectReason` — информация не теряется.)

### 5. `src/browser/nes-render/nes-view-zone-renderer.ts`

Удалить `Emitter`-импорт, три эмиттера + event-алиасы (19–26), флаг `accepting`; убрать `fire`-вызовы; упростить `accept()` и `dismiss()`. **Сохранить `isVisible()` и `clear()`.**

```ts
import { Emitter } from '@theia/core/lib/common';   // ← удалить, если Emitter больше не используется
```

Удалить поля (строки ~17–26):

```ts
private accepting = false;                                  // ← удалить
private readonly onDidShowEmitter = new Emitter<NesResponse>();    // ← удалить
private readonly onDidAcceptEmitter = new Emitter<NesResponse>();  // ← удалить
private readonly onDidDismissEmitter = new Emitter<NesResponse>(); // ← удалить
readonly onDidShow = this.onDidShowEmitter.event;          // ← удалить
readonly onDidAccept = this.onDidAcceptEmitter.event;      // ← удалить
readonly onDidDismiss = this.onDidDismissEmitter.event;    // ← удалить
```

`show()` — удалить строку `this.onDidShowEmitter.fire(response);` (49).

`accept()` — убрать `accepting` и `fire`, оставить применение правки:

```ts
accept(): void {
    const editor = this.editor;
    const response = this.response;
    if (!editor || !response || response.edits.length === 0) {
        return;
    }
    editor.executeEdits('smart-completions-nes', response.edits.map(toMonacoEdit));
    if (response.jumpTo) {
        editor.setPosition(toMonacoPosition(response.jumpTo));
        editor.revealPositionInCenterIfOutsideViewport(toMonacoPosition(response.jumpTo));
    }
    this.clear();
}
```

`dismiss()` — убрать `shouldFireDismiss`/`fire`, свести к teardown:

```ts
dismiss(): void {
    this.clear();
}
```

Оставить без изменений:

```ts
isVisible(): boolean {                       // ← СОХРАНИТЬ (nes-priority)
    return this.zoneId !== undefined && this.response !== undefined;
}
private clear(): void { ... }                // ← СОХРАНИТЬ (поправить комментарий «без telemetry-события» → просто «teardown»)
```

### 6. `src/common/nes-types.ts`

Удалить `NesResponseStatus` (72–73), `NesResponseMeta` (75–87), и поля `requestId`/`meta` у `NesResponse` (95–96):

```ts
export type NesResponseStatus = ...;     // ← удалить
export interface NesResponseMeta { ... } // ← удалить весь блок

export interface NesResponse {
    edits: TextEditDTO[];
    primaryRange?: RangeDTO;
    jumpTo?: PositionDTO;
    modelId: string;
    requestId: string;   // ← удалить
    meta: NesResponseMeta;// ← удалить
}
```

`requestId` на `NesRequest` (строка 47) — **оставить** (используется в логах).

### 7. `src/common/sweep/types.ts`

Удалить импорт `NesResponseMeta` (строка 5) и поля у `SweepResponse` (81–82):

```ts
import type { NesResponseMeta } from '../nes-types';   // ← удалить

export interface SweepResponse {
    edits: TextEditDTO[];
    primaryRange?: RangeDTO;
    jumpTo?: PositionDTO;
    modelId: SweepModelId;
    requestId: string;   // ← удалить
    meta: NesResponseMeta;// ← удалить
}
```

`requestId` на `SweepRequest` (строка 55) — **оставить** (логи).

### 8. `src/node/sweep/sweep-backend-service.ts`

Удалить импорт `NesResponseStatus` (7), упростить `emptyResponse`/`successResponse`, удалить `editLineCount`-хелпер. **Сохранить syntax-гейт и логи** (они читают `parsed.status/rejectReason`/`updatedWindow`).

```ts
import type { NesResponseStatus } from '../../common/nes-types';   // ← удалить
```

`emptyResponse` — свести к минимуму (статус/причина больше не нужны как параметры, они уже в логах вызывающих мест):

```ts
private emptyResponse(): SweepResponse {
    return { edits: [], modelId: this.config.modelId };
}
```

Обновить все вызовы `emptyResponse(...)` → `this.emptyResponse()` (строки ~74, 106, 129, 135, 143, 146). Логи рядом с ними уже содержат `requestId/durationMs/status/rejectReason` из `parsed` — их не трогать.

`successResponse` — убрать `requestId`/`meta`/`prompt`/`startedAt`:

```ts
private successResponse(edits: TextEditDTO[], primaryRange: SweepResponse['primaryRange'], jumpTo: SweepResponse['jumpTo']): SweepResponse {
    return { edits, primaryRange, jumpTo, modelId: this.config.modelId };
}
```
Обновить вызов: `return this.successResponse(parsed.edits, parsed.primaryRange, parsed.jumpTo);`

Удалить хелпер `editLineCount` (строки ~248+) целиком.

**Не трогать:** блок syntax-гейта (`request.fileMode === 'code' && parsed.updatedWindow` → `errorDelta`), все `LOG.info` с `requestId/status/rejectReason`.

### 9. `src/node/services/nes-backend-service.ts` (legacy Zeta-путь)

Тот же паттерн: удалить импорт `NesResponseStatus` (6), упростить `emptyResponse` (141) и `successResponse` (158) — убрать `requestId`/`meta`, удалить локальный `editLineCount`-хелпер (179). Вернуть `{ edits: [], modelId }` и `{ edits, primaryRange, jumpTo, modelId }` соответственно.

---

## Тесты

Текущие ассерты остаются валидными благодаря сохранённым полям:

- `test/nes-response-parser.test.ts` — проверяет `parsed.status`/`parsed.rejectReason`. **Сохраняются** (поля `ParsedSweepCompletion` не трогаем). Тест зелёный.
- `test/nes-prompt.test.ts` — проверяет `built.promptTokens`. **Сохраняется** (`BuiltSweepPrompt.promptTokens` не трогаем). Тест зелёный.

Дополнительно проверить (safety): `grep -rn "\.meta\b\|response.requestId\|NesResponseMeta\|NesResponseStatus\|SweepTelemetry" test/` — если где-то ассертится `response.meta`/`response.requestId`, удалить эти строки. По текущему коду таких ассертов в тестах нет.

---

## Проверка после удаления

- `npx tsc -b` проходит без ошибок (особое внимание — неиспользуемые импорты `Emitter`, `NesResponseStatus`, `NesResponseMeta`, `SweepTelemetry`).
- `grep -rn "Telemetry\|recordPredicted\|recordShown\|onDidShow\|onDidAccept\|onDidDismiss\|NesResponseMeta\|NesResponseStatus\|\.meta\b" src/` — пусто (кроме несвязанного `repo-indexer` `this.meta` — это индекс embedding-ов, НЕ телеметрия, не трогать).
- Команды `smart-completions.nes.telemetry.*` исчезли из палитры.
- `nes-priority` работает: `isVisible()` на месте, FIM по-прежнему уступает видимой NES-подсказке.
- Syntax-гейт работает: `parsed.updatedWindow` на месте.
- Backend-логи «почему нет правки» сохранены (читают `parsed.status/rejectReason`).
- `node --test` — `nes-response-parser` и `nes-prompt` зелёные.

## Взаимодействие с фиксом двойной токенизации

Фикс `promptTokens` (commit f3a8648) **остаётся в силе и осмысленным**: `promptTokens` сохраняется как поле `BuiltSweepPrompt` для лога «Sweep prompt built» и покрыт тестом. Удаление телеметрии лишь перестаёт класть его в `response.meta` — само поле и его дешёвый расчёт остаются. Твоя работа не пропадает.

## Что НЕ затрагивается

Профили, дедуп, syntax-гейт, trimming, prefill, reconstruction, decoding, prose-режим, оффлайн-токенизатор, redaction, cross-file edits — без изменений. Удаляется исключительно слой агрегации телеметрии и его wire-format в ответе.
