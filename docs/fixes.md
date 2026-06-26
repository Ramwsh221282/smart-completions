# fixes.md — точные правки Sweep NES (фаза «идеальная база»)

Спецификация конкретных изменений по шести пунктам ревью. Каждый пункт: проблема → затрагиваемые файлы → точная правка (код/псевдокод по реальным символам репозитория) → критерий приёмки. Все правки совместимы с текущей архитектурой (llama.server по HTTP, LanceDB). После внедрения — переход к обогащению retrieval (CodeGraph, fuzzy).

Порядок внедрения по приоритету: **1 (дедуп) → 3 (telemetry) → 2 (syntax-gate) → 4 (trimming) → 5 (nes-priority) → 6 (оффлайн-токенизатор)**. Пункты 1 и 3 блокируют обогащение retrieval, остальные параллельны.

---

## 1. Дедуп neighbors ↔ related

### Проблема
`Neighbor` (RAG, backend; `filePath`/`startLine`/`endLine`/`text`/`score`) и `SweepRelatedFile` (LSP/search/SCM, frontend; только `filePath`/`content`) встречаются только в `buildSweepPrompt`. Дедупа между ними нет — `dedupeRankRelated` дедупит related лишь между собой. В реальном промпте из `test_results` `types.ts` появился дважды с конфликтующим `User` (`fullName` vs `displayName`): один блок — свежий related/disk, другой — устаревший RAG-чанк. Плюс ни один источник не исключает `currentFilePath`, который уже целиком лежит в широком блоке.

### Файлы
- Новый: `src/common/sweep/dedup-context.ts`
- Правка: `src/node/sweep/prompt-creating-layer/sweep-prompt-builder.ts` (вызов перед `trimSweepContext`)

### Правка
Создать чистую функцию с детерминированными правилами приоритета: широкий блок (implicit) > related (свежий disk) > neighbors (индекс, может быть устаревшим).

```ts
// src/common/sweep/dedup-context.ts
import type { Neighbor } from '../embedding-types';
import type { SweepRelatedFile } from './types';

export interface DedupContextInput {
    currentFilePath: string;
    neighbors: Neighbor[];
    relatedFiles: SweepRelatedFile[];
}
export interface DedupContextResult {
    neighbors: Neighbor[];
    relatedFiles: SweepRelatedFile[];
    dropped: { neighborsByCurrentFile: number; neighborsByRelated: number; relatedByCurrentFile: number; neighborsByDup: number };
}

export function dedupeContextFiles(input: DedupContextInput): DedupContextResult {
    const current = normalizePath(input.currentFilePath);

    // Rule A: currentFilePath исключается из обоих источников — он уже в широком блоке.
    const relatedFiles = input.relatedFiles.filter(r => normalizePath(r.filePath) !== current);
    const relatedPaths = new Set(relatedFiles.map(r => normalizePath(r.filePath)));

    // Rule B: если файл уже есть в related (свежий disk), его RAG-чанки лишние и могут быть устаревшими.
    // Rule A для neighbors + Rule C: дедуп чанков по path+range.
    const seen = new Set<string>();
    const neighbors: Neighbor[] = [];
    let byCurrent = 0, byRelated = 0, byDup = 0;
    for (const n of input.neighbors) {
        const p = normalizePath(n.filePath);
        if (p === current) { byCurrent++; continue; }
        if (relatedPaths.has(p)) { byRelated++; continue; }
        const key = `${p}:${n.startLine}:${n.endLine}`;
        if (seen.has(key)) { byDup++; continue; }
        seen.add(key);
        neighbors.push(n);
    }
    return {
        neighbors,
        relatedFiles,
        dropped: { neighborsByCurrentFile: byCurrent, neighborsByRelated: byRelated, relatedByCurrentFile: input.relatedFiles.length - relatedFiles.length, neighborsByDup: byDup },
    };
}

// Нормализация пути: единый разделитель, без ведущего ./, для надёжного сравнения source-путей.
function normalizePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\.\//, '');
}
```

Вызов в `buildSweepPrompt` **до** `trimSweepContext` (чтобы триммер считал бюджет уже по дедуплицированным наборам):

```ts
// sweep-prompt-builder.ts, в начале buildSweepPrompt(), перед trimSweepContext(input, maxTokens):
const deduped = dedupeContextFiles({
    currentFilePath: input.filePath,
    neighbors: input.neighbors ?? [],
    relatedFiles: input.relatedFiles ?? [],
});
const trimInput = { ...input, neighbors: deduped.neighbors, relatedFiles: deduped.relatedFiles };
const trimmed = trimSweepContext(trimInput, maxTokens);
// в LOG.info('Sweep prompt built', {...}) добавить deduped.dropped для телеметрии дедупа.
```

### Приёмка
- В промпте не более одного блока на `filePath`; `currentFilePath` отсутствует среди neighbor/related блоков (он только в широком блоке).
- Лог содержит `dropped: { neighborsByCurrentFile, neighborsByRelated, ... }`.
- Регресс-тест: вход с neighbor `types.ts` + related `types.ts` → в выходе остаётся только related-версия.

---

## 2. Syntax-regression гейт (5-й)

### Проблема
`reject-gates.ts` содержит 4 гейта (whitespace-only, window-shape, pure-insertion-above-cursor, edit-volume), но нет проверки, что правка не сломала синтаксис. Это inference-аналог tree-sitter-reward из RL Sweep. `web-tree-sitter` 0.20.8 + `tree-sitter-wasms` 0.1.13 уже в зависимостях и используются в `TreeSitterChunker`.

### Файлы
- Новый: `src/node/sweep/model-call-layer/syntax-gate.ts`
- Правка: `src/node/sweep/model-call-layer/sweep-response-parser.ts` (вернуть `updatedWindow` и `status/rejectReason`)
- Правка: `src/node/sweep/sweep-backend-service.ts` (async-гейт после парсинга, только code-режим)

### Правка
Гейт переиспользует паттерн загрузки из `TreeSitterChunker` (тот же `Parser.init` с `locateFile`, тот же `grammarForLanguage`). Сравнивает **дельту** числа ошибок, а не абсолют: окна — фрагменты, у обоих одинаковый граничный «шум» (незакрытые скобки на краях), и дельта изолирует эффект правки.

```ts
// src/node/sweep/model-call-layer/syntax-gate.ts
import Parser from 'web-tree-sitter';
import { grammarForLanguage } from '../../embedding-module/chunker/language-registry';

type LanguageLoader = { load(input: string): Promise<unknown> };

export class SweepSyntaxGate {
    private parser: Parser | undefined;
    private readonly languages = new Map<string, unknown>();
    private initialized = false;
    private failed = false;

    /** Возвращает (errors(new) - errors(old)); undefined = язык не поддержан или парсер недоступен (гейт пропускается). */
    async errorDelta(oldWindow: string, newWindow: string, languageId: string): Promise<number | undefined> {
        const grammar = grammarForLanguage(languageId);
        if (!grammar || this.failed) return undefined;
        try {
            await this.ensureInit();
            const lang = await this.loadLanguage(grammar);
            this.parser!.setLanguage(lang as Parameters<Parser['setLanguage']>[0]);
            return this.errorCount(newWindow) - this.errorCount(oldWindow);
        } catch {
            this.failed = true; // один раз упало — больше не пытаемся, gate тихо пропускается
            return undefined;
        }
    }

    private errorCount(source: string): number {
        const tree = this.parser!.parse(source);
        try {
            let count = 0;
            const cursor = tree.walk();
            const visit = (): void => {
                do {
                    const node = cursor.currentNode();
                    if (node.type === 'ERROR' || node.isMissing()) count++;
                    if (cursor.gotoFirstChild()) { visit(); cursor.gotoParent(); }
                } while (cursor.gotoNextSibling());
            };
            visit();
            return count;
        } finally {
            tree.delete();
        }
    }

    private async ensureInit(): Promise<void> {
        if (this.initialized) return;
        await Parser.init({ locateFile: (f: string) => require.resolve('web-tree-sitter/' + f) });
        this.parser = new Parser();
        this.initialized = true;
    }
    private async loadLanguage(grammar: string): Promise<unknown> {
        let lang = this.languages.get(grammar);
        if (!lang) {
            const wasm = require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
            lang = await (Parser as unknown as { Language: LanguageLoader }).Language.load(wasm);
            this.languages.set(grammar, lang);
        }
        return lang;
    }
}
```

В `sweep-response-parser.ts` — вернуть `updatedWindow` и причину, чтобы backend мог отдать в telemetry и запустить async-гейт:

```ts
export interface ParsedSweepCompletion {
    edits: TextEditDTO[];
    primaryRange?: RangeDTO;
    jumpTo?: PositionDTO;
    updatedWindow?: string;          // NEW: для syntax-гейта на backend
    status: 'edit' | 'no-edit' | 'rejected';   // NEW
    rejectReason?: string;           // NEW: причина из sweepRejectReason
}
// на каждом return проставлять status/rejectReason; при успехе добавлять updatedWindow.
```

В `SweepBackendService.predict()` — после `parseSweepCompletion`, перед возвратом:

```ts
private readonly syntaxGate = new SweepSyntaxGate();   // singleton поля класса

// ...после const parsed = parseSweepCompletion({...}):
let rejectReason = parsed.rejectReason;
if (parsed.edits.length > 0 && request.fileMode === 'code' && parsed.updatedWindow) {
    const delta = await this.syntaxGate.errorDelta(windowText, parsed.updatedWindow, request.languageId);
    if (delta !== undefined && delta > 0) {
        LOG.info('Sweep edit rejected by syntax gate', { requestId: request.requestId, delta });
        return this.emptyResponse(request, 'rejected', 'syntax-regression', startedAt);
    }
}
```

### Приёмка
- Code-режим: правка, добавляющая синтаксическую ошибку (новый ERROR/MISSING-узел) относительно старого окна, отклоняется с `reject_reason: 'syntax-regression'`.
- Prose-режим и неподдерживаемые языки: гейт пропускается (`errorDelta` → undefined), правка проходит.
- Сбой парсера один раз → `failed=true`, дальше гейт не блокирует (graceful).

---

## 3. Telemetry — acceptance-side

### Проблема
Request-side логи богатые (`durationMs`, `reject_reason` в логах, `tokenCounterMode`, бюджеты), но нет учёта **принял/отклонил пользователь** и агрегации. Без acceptance-метрик нельзя измерить эффект обогащения retrieval. Часть dismiss-путей идёт мимо `controller.dismiss()` (в `trackEditor` при изменении контента вызывается `this.renderer.dismiss()` напрямую) — значит точка перехвата должна быть в рендерере.

### Файлы
- Правка: `src/common/nes-types.ts` (`NesResponse` + `requestId`/`status`/`meta`)
- Правка: `src/node/sweep/sweep-backend-service.ts` (заполнять meta на всех return-путях)
- Правка: `src/browser/nes-render/nes-view-zone-renderer.ts` (эмиттеры show/accept/dismiss)
- Новый: `src/browser/sweep/telemetry/sweep-telemetry.ts`
- Правка: `src/browser/sweep/trigger-layer/sweep-controller.ts` (подписка + корреляция)
- Правка: `src/browser/commands.ts` (команда dump/reset)

### Правка
Расширить ответ метаданными (заполняются на всех путях: edit / no-edit / rejected / overflow / error):

```ts
// nes-types.ts
export interface NesResponseMeta {
    status: 'edit' | 'no-edit' | 'rejected' | 'overflow' | 'error';
    rejectReason?: string;
    durationMs: number;
    promptTokens?: number;
    tokenMode: 'tokenizer' | 'char-fallback';
    contextProfile: string;
    editLineCount?: number;
}
export interface NesResponse {
    edits: TextEditDTO[];
    primaryRange?: RangeDTO;
    jumpTo?: PositionDTO;
    modelId: string;
    requestId: string;      // NEW: корреляция predicted↔shown↔accepted
    meta: NesResponseMeta;  // NEW
}
```

Backend `predict()` через хелпер `emptyResponse(request, status, rejectReason, startedAt)` и финальный success-возврат проставляет `requestId`, `meta`. `promptTokens`/`tokenMode`/`contextProfile` уже доступны из `trimmed`/`profile`/`tokenCounter.mode`.

Рендерер — эмиттеры (Theia `Emitter`), чтобы поймать ВСЕ пути:

```ts
// nes-view-zone-renderer.ts
import { Emitter } from '@theia/core/lib/common';
private readonly onDidShowEmitter = new Emitter<NesResponse>();
private readonly onDidAcceptEmitter = new Emitter<NesResponse>();
private readonly onDidDismissEmitter = new Emitter<NesResponse>();
readonly onDidShow = this.onDidShowEmitter.event;
readonly onDidAccept = this.onDidAcceptEmitter.event;
readonly onDidDismiss = this.onDidDismissEmitter.event;

// show(): после успешного addZone, если edits.length>0 → this.onDidShowEmitter.fire(response);
// accept(): перед this.dismiss() запомнить response, после executeEdits → this.onDidAcceptEmitter.fire(resp);
// dismiss(): если был активный this.response → this.onDidDismissEmitter.fire(prevResponse) ПЕРЕД обнулением.
// isVisible(): boolean  → нужен также для пункта 5 (nes-priority)
isVisible(): boolean { return this.zoneId !== undefined && this.response !== undefined; }
```

Sink с агрегацией (frontend, singleton):

```ts
// sweep-telemetry.ts
@injectable()
export class SweepTelemetry {
    private readonly statusCounts = new Map<string, number>();
    private readonly rejectReasons = new Map<string, number>();
    private shown = 0; private accepted = 0; private dismissed = 0; private stale = 0;
    private readonly latencyMs: number[] = [];

    recordPredicted(r: NesResponse): void {
        bump(this.statusCounts, r.meta.status);
        if (r.meta.rejectReason) bump(this.rejectReasons, r.meta.rejectReason);
        this.latencyMs.push(r.meta.durationMs);
    }
    recordShown(): void { this.shown++; }
    recordAccepted(): void { this.accepted++; }
    recordDismissed(): void { this.dismissed++; }
    recordStale(): void { this.stale++; }

    snapshot() {
        return {
            status: Object.fromEntries(this.statusCounts),
            rejectReasons: Object.fromEntries(this.rejectReasons),
            shown: this.shown, accepted: this.accepted, dismissed: this.dismissed, stale: this.stale,
            acceptanceRate: this.shown ? this.accepted / this.shown : 0,
            p50: percentile(this.latencyMs, 50), p95: percentile(this.latencyMs, 95),
        };
    }
    reset(): void { /* очистить всё */ }
}
```

Контроллер — подписка и корреляция. `recordPredicted` сразу после `predict`; stale-детект по версии модели; show/accept/dismiss из эмиттеров рендерера:

```ts
// sweep-controller.ts onStart(): подписаться один раз
this.toDispose.push(this.renderer.onDidShow(() => this.telemetry.recordShown()));
this.toDispose.push(this.renderer.onDidAccept(() => this.telemetry.recordAccepted()));
this.toDispose.push(this.renderer.onDidDismiss(() => this.telemetry.recordDismissed()));

// в trigger(): после const response = await this.nes.predict(...):
this.telemetry.recordPredicted(response);
if (model.getVersionId() !== version) { this.telemetry.recordStale(); return; }
```

Команда `smart-completions.nes.telemetry.dump` → `console.info(this.telemetry.snapshot())`; `...reset` → `telemetry.reset()`.

### Приёмка
- Каждый predict даёт `recordPredicted` с `status`; reject-причины (включая `syntax-regression` из п.2) видны в гистограмме.
- `acceptanceRate = accepted / shown` считается; dismiss при изменении контента учитывается (через `onDidDismiss`).
- Команда dump печатает снапшот со статусами, reject-причинами, acceptance rate, p50/p95 латентности.

---

## 4. Trimming-приоритет (recent edits vs error diagnostics)

### Проблема
В `trimSweepContext` порядок: `takeDiagnostics(errors)` → recent edits → neighbors/related → warnings → outline → output. Error-диагностика берёт бюджет раньше recent edits, хотя для модели на edit-трейсах recent edits — главный сигнал. Но локальная ошибка у курсора — это и есть «что чинить», её терять нельзя.

### Файлы
- Правка: `src/node/sweep/data-formatting-layer/context-trimmer.ts`

### Правка
Разделить error-диагностики на **локальные к курсору** (в радиусе R строк) и **дальние**. Локальные остаются высоко (сигнал фикса), дальние опускаются ниже recent edits.

```ts
// context-trimmer.ts
const CURSOR_ERROR_RADIUS = 3;

// строка курсора в координатах документа:
const cursorDocLine = (input.windowStartLine ?? 0) + lineIndexAtOffset(clamped.text, clamped.cursorOffset);

// разбить errorDiagnostics:
const localErrors: DiagnosticDTO[] = [];
const distantErrors: DiagnosticDTO[] = [];
for (const d of errorDiagnostics) {
    (Math.abs(d.range.start.line - cursorDocLine) <= CURSOR_ERROR_RADIUS ? localErrors : distantErrors).push(d);
}

// НОВЫЙ порядок взятия бюджета:
takeDiagnostics(localErrors, 'local-errors');   // 1. локальная ошибка = что чинить
//   recentEdits loop                            // 2. главный Sweep-сигнал (как сейчас)
//   neighbors loop                              // 3.
//   related loop                                // 4.
takeDiagnostics(distantErrors, 'distant-errors');// 5. дальние ошибки ниже recent edits
takeDiagnostics(warningDiagnostics, 'warnings'); // 6.
//   outline, output                             // 7-8.
```

(`lineIndexAtOffset` уже реализован в `reject-gates.ts` — вынести в общий util `src/common/text/` и переиспользовать, либо продублировать локально.)

### Приёмка
- При ошибке у курсора (≤3 строк): диагностика сохраняется даже при тесном бюджете.
- При дальней ошибке и большой истории правок: recent edits не вытесняются дальней диагностикой.
- Лог trimmer показывает фазы `local-errors` / `distant-errors` раздельно.

---

## 5. `nes-priority` — реализовать

### Проблема
`nes-priority` объявлен в enum preferences и в `CoordinationMode`, но поведенческой ветки нет. Семантика: NES имеет приоритет — FIM уступает, когда NES-подсказка видима.

### Файлы
- Правка: `src/browser/fim-module/fim-inline-provider.ts` (инжект рендерера + ветка)
- (Контроллер менять не нужно: `exclusive-priority`-тайминг-гейт срабатывает только при `coordinationMode === 'exclusive-priority'`, так что `nes-priority` уже не глушит NES.)

### Правка
FIM уступает NES, когда подсказка видима (`isVisible()` из п.3):

```ts
// fim-inline-provider.ts
import { NesViewZoneRenderer } from '../nes-render/nes-view-zone-renderer';
@inject(NesViewZoneRenderer) private readonly nesRenderer!: NesViewZoneRenderer;

// в начале provideInlineCompletions():
if (!this.enabled || this.coordinationMode === 'nes-only') {
    return undefined;
}
if (this.coordinationMode === 'nes-priority' && this.nesRenderer.isVisible()) {
    return undefined;   // NES показывает подсказку — FIM уступает
}
```

`NesViewZoneRenderer` уже singleton во frontend DI (`bind(NesViewZoneRenderer).toSelf().inSingletonScope()`), так что инжект в FIM безопасен и делит тот же экземпляр, что контроллер.

Опционально (если будет нужно усилить приоритет): под `nes-priority` увеличивать FIM-debounce, чтобы NES получал первый шанс. Не обязательно для базовой семантики.

### Приёмка
- В режиме `nes-priority`: пока View Zone NES видима, FIM не показывает ghost-text.
- После dismiss NES (`isVisible()` → false) FIM возобновляется на следующем триггере.
- Остальные режимы (`exclusive-priority`, `parallel`, `fim-only`, `nes-only`) не меняются.

---

## 6. Оффлайн-бандлинг токенизатора `@xenova/transformers`

### Проблема
`QwenTokenCounter.load()` вызывает `AutoTokenizer.from_pretrained('Qwen/Qwen2.5-Coder-1.5B')`, который по умолчанию тянет файлы с HF Hub. На оффлайн-установке первый запуск не загрузит токенизатор → тихий уход в `char-fallback` (token-aware budget не работает). Токенизатор должен поставляться с плагином.

### Файлы
- Новый ресурс: `resources/tokenizers/qwen2.5-coder/` (файлы токенизатора)
- Правка: `src/node/sweep/token-budget/token-counter.ts` (локальный путь + запрет сети)
- Правка: `package.json` (`files`, копирование ресурсов в `lib`)
- Правка: `src/node/sweep/sweep-backend-service.ts` (warmup при старте)

### Правка
1. Вендорить минимальный набор для transformers.js: `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json` в `resources/tokenizers/qwen2.5-coder/`. (ONNX-веса НЕ нужны — нужен только токенизатор.)

2. В `token-counter.ts` сконфигурировать env ДО `from_pretrained`, запретить сеть и указать локальный путь:

```ts
import * as path from 'node:path';
private async load(): Promise<void> {
    try {
        const mod = await import('@xenova/transformers') as TransformersModule & { env?: any };
        if (mod.env) {
            mod.env.allowRemoteModels = false;            // никогда не ходить в сеть
            mod.env.allowLocalModels = true;
            // __dirname = lib/node/sweep/token-budget → подняться к корню плагина и в resources
            mod.env.localModelPath = path.join(__dirname, '../../../../resources/tokenizers');
        }
        if (!mod.AutoTokenizer) { this.fallback = true; return; }
        // имя = подпапка в localModelPath, не HF-repo
        this.tokenizer = await mod.AutoTokenizer.from_pretrained('qwen2.5-coder');
    } catch {
        this.fallback = true;
    }
}
// DEFAULT_QWEN_TOKENIZER заменить на локальное имя 'qwen2.5-coder'.
```

3. `package.json`: добавить `resources` в `files`; добавить копирование ресурсов в `lib` после `tsc` (tsc не копирует не-TS):

```json
"files": ["lib", "src", "resources"],
"scripts": {
    "build": "tsc -b && npm run copy-resources",
    "copy-resources": "node -e \"require('node:fs').cpSync('resources','lib/resources',{recursive:true})\""
}
```
(Тогда `localModelPath` резолвить относительно `lib/resources/tokenizers` — выверить путь от `__dirname` после сборки.)

4. Warmup: вызвать `this.tokenCounter.ensureReady()` в `SweepBackendService.configure()` (а не только в `predict`), чтобы первая подсказка не платила за загрузку.

5. (Опционально, к обсуждению) `@xenova/transformers` тянет тяжёлые транзитивные зависимости (onnxruntime) ради токенизатора. Альтернатива — пакет `tokenizers` или чистый BPE по `tokenizer.json`. Не входит в эту правку; зафиксировать как будущий вопрос оптимизации зависимостей.

### Приёмка
- На оффлайн-машине первый predict загружает токенизатор из `resources/` без сети; `tokenCounter.mode === 'tokenizer'`.
- При повреждении/отсутствии ресурса — `char-fallback`, плагин работает.
- `ensureReady()` отрабатывает на `configure()`; первая подсказка не имеет лишней задержки загрузки.

---

## Связки между правками

- Пункт 3 даёт `isVisible()` на рендерере, который использует пункт 5 — внедрять 3 до 5.
- Пункт 2 добавляет `reject_reason: 'syntax-regression'`, который агрегируется телеметрией пункта 3 — оба пишут в один gate/telemetry-поток.
- Пункт 1 уменьшает дубли до того, как пункт 3 начнёт мерить acceptance — иначе baseline искажён дублированием.
- `lineIndexAtOffset` используется в пунктах 2 и 4 — вынести в общий util один раз.

## Что НЕ трогать (подтверждено корректным в коде)

Профили (`profiles.ts`), широкий блок (`editorBroadWindow`), окно по профилю, реконструкция `original/` с верификацией хунка, prefill (`computeDefaultPrefill`), decoding (`temperature: profile.temperature`, `cache_prompt`, `seed`), 4 существующих reject-гейта, prose-окно, глобальная история правок (cross-file edits уже работают через `EditHistoryStore.getRecentEdits`), redaction секретов (`output-filter.ts`). Эти части менять не нужно.
