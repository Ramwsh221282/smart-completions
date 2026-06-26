# Developer Rules

Настоящий документ описывает правила кодирования в текущем проекте. Эти правила должны строго соблюдаться и проверяться.

## Комментирование кода

- Комментарий объясняет **зачем** эта структура присутствует в коде, а не что она делает синтаксически.
- Методология: сначала прочитать код, понять его роль в системе, посмотреть где используется и что вызывает — затем написать комментарий.
- Максимум 3 строки. Кратко и по существу.
- Правило единое для любой структуры: класс, поле, функция, константа, модуль.

## Best Practices: производительный код на TypeScript

> Ключевой критерий — **скорость выполнения (runtime)**. Важно понимать: типы TypeScript стираются при компиляции и сами по себе нулевой ценой в рантайме. Реально на скорость влияет JavaScript, который генерируется, и то, насколько он «удобен» движку (V8/TurboFan, SpiderMonkey, JavaScriptCore). Поэтому большинство практик ниже — это про то, как писать код, который JIT-компилятор может агрессивно оптимизировать.

---

## 1. Предсказуемость — главное, что любит движок

V8 представляет объекты через **hidden classes** (он же *shapes* / *maps*). Объекты с одинаковой формой обрабатываются одним и тем же оптимизированным машинным кодом. Любая «динамика» ломает это и приводит к деоптимизации.

**Инициализируй все поля сразу и в одном порядке.** Объекты, созданные по-разному, получают разные hidden classes:

```ts
// ❌ Разные формы → разные hidden classes
const a = { name: "Alice" };
a.age = 30;
const b = { age: 25 };
b.name = "Bob";

// ✅ Одна фабрика/конструктор → одна форма
function createUser(name: string, age: number) {
  return { name, age }; // одинаковый порядок, все поля заданы
}
```

**Не добавляй свойства после создания** и не делай их условными. Если поле иногда есть, а иногда нет — инициализируй его значением по умолчанию (`null`):

```ts
// ❌ Условное добавление поля плодит формы
if (premium) user.plan = "pro";

// ✅ Фиксированная форма
const user = { name, age, plan: null as string | null };
```

**Никогда не используй `delete` в горячем коде.** `delete` переводит объект в медленный «словарный» режим (dictionary mode) — это билет в один конец:

```ts
// ❌ delete ломает hidden class
delete user.plan;

// ✅ Просто обнуляй
user.plan = null; // или undefined
```

---

## 2. Мономорфные функции и инлайнинг

JIT кэширует типы в точке вызова (**inline cache**). Состояния:

- **monomorphic** — один тип объекта/аргумента: самый быстрый путь;
- **polymorphic** — несколько форм: медленнее;
- **megamorphic** — слишком много форм: движок сдаётся и переходит на медленный словарный поиск.

**Передавай в функцию аргументы стабильных типов.** TurboFan перестаёт оптимизировать функцию, если типы аргументов «прыгают»:

```ts
// ❌ Деоптимизация: типы меняются
function sum(a: any, b: any) { return a + b; }
sum(1, 2);       // оптимизировано под числа
sum("1", "2");   // деоптимизация

// ✅ Стабильный тип на входе
function sum(a: number, b: number) { return a + b; }
```

**Держи функции маленькими** — мелкие функции TurboFan чаще инлайнит, убирая накладные расходы на вызов и открывая новые оптимизации.

**Это, кстати, лучший прикладной аргумент против `any`.** Дело не только в безопасности типов: `any` поощряет код, где у значений нет стабильного рантайм-типа, что напрямую мешает JIT. Опирайся на вывод типов (type inference) и убирай лишние утверждения (`as`), которые не несут пользы.

---

## 3. TypeScript-специфичные конструкции с нулевой ценой

Некоторые фичи TS генерируют лишний рантайм-код и раздувают бандл (а значит, и время парсинга/выполнения).

**Вместо `enum` — `as const`-объект или `const enum`.** Обычный `enum` компилируется в рантайм-объект (~десятки-сотни байт лишнего кода):

```ts
// ❌ enum → рантайм-объект
enum Direction { Up = "UP", Down = "DOWN" }

// ✅ as const → ноль рантайм-кода, та же типобезопасность
const Direction = { Up: "UP", Down: "DOWN" } as const;
type Direction = typeof Direction[keyof typeof Direction]; // "UP" | "DOWN"
```

`const enum` инлайнится при компиляции (тоже ноль рантайм-кода), но **осторожно**: его не понимают изолированные транспиляторы (Babel, esbuild, `isolatedModules`) без особой настройки. Для библиотек и сборок на esbuild/swc безопаснее паттерн `as const`.

**Используй `import type` для импортов, нужных только для типов** — они полностью удаляются из вывода и не тянут лишнее в бандл:

```ts
import type { User } from "./models"; // исчезнет при компиляции
```

**Избегай `namespace`** — он компилируется в IIFE, который не поддаётся tree-shaking. Используй ES-модули с именованными экспортами.

**Минимизируй лишние утверждения типов** — `(x as number) + (y as number)` не даёт ничего, кроме шума; полагайся на вывод типов.

---

## 4. Правильные структуры данных

Выбор структуры данных меняет асимптотику — это почти всегда важнее микрооптимизаций.

- **`Map` / `Set` для частых вставок, удалений и поиска по ключу** — вместо объектных литералов. `Map` рассчитан на динамические коллекции и не страдает от смены hidden class при добавлении ключей.
- **Объектный литерал** хорош для фиксированного, заранее известного набора полей.
- **Типизированные массивы (`Uint8Array`, `Float64Array`, …) для числовых данных** — до ~2x быстрее обычных массивов и заметно экономнее по памяти, т.к. хранят данные плоско, без боксинга.

```ts
// Частый поиск по ключу
const cache = new Map<string, User>();
cache.set(id, user);
const u = cache.get(id);

// Числовые данные
const samples = new Float64Array(1024);
```

---

## 5. Работа с массивами

**Держи массивы «упакованными» (packed) и одного типа элементов.** «Дыры» (holes) — результат `delete` или `arr[100] = x` при длине 3 — переводят массив в медленный режим. Даже одно удаление резко замедляет всё.

```ts
// ❌ Дыра → деоптимизация массива
const arr = [1, 2, 3];
delete arr[1];

// ✅ Без дыр
arr[1] = 0;
```

**Избегай промежуточных копий в цепочках.** Каждый `.filter().map().slice()` создаёт новый массив. В горячем пути сливай операции в один проход:

```ts
// ❌ Копия на каждом шаге
const out = arr.filter(f).map(m).slice(10);

// ✅ Один проход, одна аллокация
const out: T[] = [];
for (let i = 0; i < arr.length; i++) {
  if (f(arr[i])) out.push(m(arr[i]));
}
```

**Фильтруй до `map`**, а не после — так преобразуется меньше элементов.

**Преаллоцируй массив, если длина известна** — это убирает повторные реаллокации при росте. Но **заполняй его** (не оставляй дыр) и не выделяй с огромным запасом:

```ts
const result = new Array(n);
for (let i = 0; i < n; i++) result[i] = compute(i);
```

**Про `for` против `map`/`forEach` — без догматизма.** Функциональные методы читаемее и в большинстве кода достаточно быстры (движок их хорошо оптимизирует). Но на **горячем пути** с миллионами итераций обычный индексный `for` без колбэка обычно быстрее, т.к. нет накладных расходов на вызов функции на каждый элемент. Оптимизируй так только там, где профиль показал проблему.

```ts
// Мелочь, но в горячих циклах помогает: кэшируй длину
for (let i = 0, len = arr.length; i < len; i++) { /* ... */ }
```

---

## 6. Память и сборщик мусора (GC)

GC-паузы — частая причина «подлагиваний». Меньше мусора → меньше пауз.

- **Минимизируй аллокации в горячем пути.** Переиспользуй объекты вместо создания новых в цикле; для очень частых короткоживущих объектов рассмотри **object pooling** (пул переиспользуемых объектов, например в игровом цикле или симуляции).
- **Не создавай мусор в тесных циклах** — лишние временные объекты/массивы давят на GC.
- **Чисти за собой:** снимай обработчики событий (`removeEventListener`), очищай таймеры (`clearInterval`), иначе ссылки удерживают объекты в памяти и приложение медленно «толстеет».
- **`WeakMap` / `WeakSet` для кэшей с ключами-объектами** — записи автоматически собираются GC, когда ключ больше нигде не нужен.
- **Избегай случайных глобальных переменных** и замыканий, удерживающих большие объекты дольше, чем нужно.

---

## 7. Строки и регулярные выражения

**Не склеивай строки через `+=` в длинных циклах** — это плодит множество промежуточных строк и давит на GC. Собирай в массив и склеивай один раз:

```ts
// ❌ Тысячи промежуточных строк
let s = "";
for (let i = 0; i < n; i++) s += part(i);

// ✅ Один join
const parts: string[] = [];
for (let i = 0; i < n; i++) parts.push(part(i));
const s = parts.join("");
```

**Компилируй регулярки один раз, вне горячей функции** — не пересоздавай `new RegExp(...)` на каждой итерации. И избегай шаблонов с катастрофическим бэктрекингом.

```ts
const VALUE_RE = /value=(\d+)/; // один раз
function extract(text: string) {
  return text.match(VALUE_RE)?.[1] ?? null;
}
```

---

## 8. Асинхронность и параллелизм

**Запускай независимые асинхронные операции параллельно через `Promise.all`,** а не последовательно в цикле. Это меняет время с `O(n × latency)` на `O(max latency)`:

```ts
// ❌ Последовательно: суммируются все задержки
const results = [];
for (const url of urls) results.push(await fetch(url));

// ✅ Параллельно: ждём только самый долгий запрос
const results = await Promise.all(urls.map((u) => fetch(u)));
```

**Разбивай большие задачи на батчи (chunking),** чтобы не блокировать событийный цикл и не упереться в память при обработке миллионов элементов:

```ts
async function processInBatches<T>(items: T[], size: number) {
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    await processBatch(batch); // отдаём контроль event loop между батчами
  }
}
```

**Выноси тяжёлые CPU-вычисления в Web Workers** (в браузере) или **`worker_threads`** (в Node), чтобы не морозить основной поток / UI.

---

## 9. Сборка и конфигурация (влияет на рантайм)

- **`target` на современный ES** (например, актуальный `ES2022`+, если позволяет окружение). Чем меньше даунлевелинга в старый синтаксис и полифилов, тем компактнее и быстрее вывод.
- **Дружелюбный к tree-shaking код:** именованные экспорты вместо одного большого объекта по умолчанию — тогда бандлер выкинет неиспользуемое.

```ts
// ❌ Плохо для tree-shaking
export default { helper1() {}, helper2() {} };
// ✅ Хорошо
export const helper1 = () => {};
export const helper2 = () => {};
```

- **Минификация и бандлинг в продакшене** (esbuild, swc, Rollup, Webpack) — меньше байт, меньше парсинга, быстрее старт.
- **`strict` режим** напрямую рантайм не ускоряет (типы стираются), но поощряет код со стабильными типами значений — а это как раз то, что помогает JIT строить мономорфные оптимизации. Плюс ошибки ловятся на этапе компиляции.

---

## 10. Быстрый чеклист

**Формы объектов**
- [ ] Все поля инициализированы сразу, в одном порядке
- [ ] Нет добавления свойств после создания и нет `delete`
- [ ] Условные поля заданы как `null`, а не отсутствуют

**Функции**
- [ ] Аргументы стабильного типа (мономорфизм)
- [ ] Функции маленькие (инлайнинг)
- [ ] Минимум `any` и лишних `as`

**TypeScript-конструкции**
- [ ] `as const` / `const enum` вместо `enum`
- [ ] `import type` для типовых импортов
- [ ] Нет `namespace`

**Данные и циклы**
- [ ] `Map`/`Set` для динамического поиска; типизированные массивы для чисел
- [ ] Массивы упакованы (без дыр), один тип элементов
- [ ] Нет лишних промежуточных копий в цепочках; `for` на горячем пути
- [ ] Преаллокация при известной длине

**Память**
- [ ] Минимум аллокаций в горячем пути (переиспользование/пулы)
- [ ] Сняты слушатели/таймеры; `WeakMap`/`WeakSet` для кэшей

**Строки/регулярки**
- [ ] `join` вместо `+=` в циклах
- [ ] RegExp компилируется один раз

**Асинхронность**
- [ ] Независимые операции — через `Promise.all`
- [ ] Большие объёмы — батчами; тяжёлый CPU — в воркерах

---

## 11. Циклы: что реально быстрее

### Индексный `for` vs колбэк-методы (`forEach` / `map` / `filter` / `reduce`)

Разрыв реальный и устойчивый. Вызов колбэка на каждый элемент не бесплатен; `map`/`filter` ещё аллоцируют новый массив. На плотном массиве в миллион элементов обычные циклы примерно в 3–4 раза быстрее `forEach`/`map` и почти в 3.5 раза быстрее `reduce`. На горячем пути с большими данными выбирай индексный `for`:

```ts
// ❌ Горячий путь: колбэк на каждой итерации + аллокация нового массива
const result = arr.map(x => x * 2);

// ✅ Горячий путь: нет колбэков, нет лишних аллокаций
const result = new Array<number>(arr.length);
for (let i = 0; i < arr.length; i++) result[i] = arr[i] * 2;
```

### Индексный `for` vs `for...of`

Разница почти исчезла. Современный V8 (TurboFan/Maglev) после прогрева оптимизирует `for...of` до уровня, сравнимого с индексным циклом. Индексный `for` остаётся самым стабильным вариантом (особенно на очень больших массивах, где у `for...of` могут возникнуть проблемы с warmup), но выбирать между ними стоит по читаемости — до того момента, когда профиль не укажет на проблему.

```ts
// Оба варианта сравнимы по скорости на типичных данных:
for (let i = 0; i < arr.length; i++) process(arr[i]);
for (const item of arr) process(item);
```

### `for...in` на массивах — никогда

`for...in` обходит строковые ключи включая унаследованные перечисляемые свойства. Это семантически неверно и медленно. Для массивов — только `for`, `for...of` или методы.

### Что кэшировать — а что нет

Кэширование `arr.length` в переменную (`let len = arr.length`) — no-op в современном V8. Движок делает это сам. Это привычка из других языков, не оптимизация.

Зато то, что стоит вынести из цикла:

- Вызовы функций с постоянным результатом
- Обращения к глубоко вложенным свойствам
- Создание объектов / регулярных выражений

```ts
// ❌ Три раза проходим по цепочке на каждой итерации
for (let i = 0; i < n; i++) {
  if (items[i].value > config.limits.maxValue) {
    items[i].status = config.defaults.status;
  }
}

// ✅ Один раз
const max = config.limits.maxValue;
const defaultStatus = config.defaults.status;
for (let i = 0; i < n; i++) {
  if (items[i].value > max) items[i].status = defaultStatus;
}
```

```ts
// ❌ Вычисление threshold и создание regex на каждой итерации
for (let i = 0; i < items.length; i++) {
  const threshold = config.limits.maxValue * 0.9;
  const re = /^\d+$/;
  if (re.test(items[i].code) && items[i].value > threshold) { ... }
}

// ✅ Вынести инварианты
const threshold = config.limits.maxValue * 0.9;
const re = /^\d+$/;
for (let i = 0; i < items.length; i++) {
  if (re.test(items[i].code) && items[i].value > threshold) { ... }
}
```

### Ранний выход из цикла

Используй `break` / `continue`, чтобы не делать лишних итераций:

```ts
// ❌ Идём до конца даже после находки
const found = arr.filter(x => x.id === targetId)[0];

// ✅ Останавливаемся сразу
let found: Item | undefined;
for (let i = 0; i < arr.length; i++) {
  if (arr[i].id === targetId) { found = arr[i]; break; }
}
```

### Не создавай функции и объекты внутри цикла

Каждая итерация плодит новые объекты в heap — давление на GC и новые hidden class:

```ts
// ❌ Новая функция-колбэк на каждой итерации
items.forEach((item, i) => {
  handlers[i] = () => process(item); // новое замыкание каждый раз
});

// ✅ Выноси или переиспользуй
function makeHandler(item: Item) { return () => process(item); }
items.forEach((item, i) => { handlers[i] = makeHandler(item); });
```

---

## 12. Мемоизация и ленивая инициализация

**Мемоизация** — кэшируй результат дорогой функции по аргументам. Особенно выгодна, когда функция вызывается многократно с одними и теми же входными данными:

```ts
const cache = new Map<number, number>();

function expensiveFn(x: number): number {
  if (cache.has(x)) return cache.get(x)!;
  const result = /* долгое вычисление */ x ** 3;
  cache.set(x, result);
  return result;
}
```

Универсальная обёртка:

```ts
function memoize<A extends unknown[], R>(fn: (...args: A) => R) {
  const cache = new Map<string, R>();
  return (...args: A): R => {
    const key = JSON.stringify(args);
    if (cache.has(key)) return cache.get(key)!;
    const result = fn(...args);
    cache.set(key, result);
    return result;
  };
}
```

Ограничения: ключ через `JSON.stringify` медленен на больших объектах; для примитивных аргументов лучше строить ключ вручную.

**Ленивая инициализация** — не создавай дорогой объект до первого реального использования:

```ts
class Service {
  private _parser: HeavyParser | null = null;

  get parser(): HeavyParser {
    if (!this._parser) this._parser = new HeavyParser();
    return this._parser;
  }
}
```

---

## 13. Короткое замыкание (short-circuit evaluation)

`&&` и `||` не вычисляют правый операнд, если результат уже определён левым. Ставь дешёвое или вероятно-ложное условие первым:

```ts
// ❌ Сначала дорогая проверка
if (expensiveCheck(data) && data.length > 0) { ... }

// ✅ Сначала дешёвая
if (data.length > 0 && expensiveCheck(data)) { ... }
```

Используй `??` вместо `||`, когда значение может быть `0` или `""` — иначе они будут ошибочно заменены дефолтом:

```ts
const value = input ?? defaultValue;  // только null/undefined → default
const value = input || defaultValue;  // 0, "" тоже → default (часто баг)
```

---

## 14. Ранний выход (guard clauses)

Проверяй невалидные условия в самом начале функции и возвращайся. Это сокращает вычисления и убирает лишние уровни вложенности:

```ts
// ❌ Вся логика внутри if-else
function process(data: Data | null) {
  if (data) {
    if (data.items.length > 0) {
      // основная логика
    }
  }
}

// ✅ Ранний выход
function process(data: Data | null) {
  if (!data) return;
  if (data.items.length === 0) return;
  // основная логика — без вложенности
}
```

---

## 15. `try-catch`: не в горячем пути

Исторически `try-catch` блокировал оптимизацию всей функции в V8. В современном TurboFan (Node 8.3+) это уже не проблема для самого блока, но вызов функции изнутри `try` по-прежнему может быть медленнее, а при определённых сочетаниях возможны бесконечные циклы деоптимизации/реоптимизации. Общий принцип:

```ts
// ❌ Тяжёлая логика внутри try
function hotPath(data: Data[]) {
  try {
    for (let i = 0; i < data.length; i++) {
      heavyCompute(data[i]); // деоптимизация возможна
    }
  } catch (e) { ... }
}

// ✅ try только вокруг реально бросающего кода
function hotPath(data: Data[]) {
  for (let i = 0; i < data.length; i++) heavyCompute(data[i]);
}
function safeWrapper(data: Data[]) {
  try { hotPath(data); } catch (e) { handleError(e); }
}
```

---

## 16. Отладочное логирование вырезаем из продакшн-сборки

`LOG.debug(...)` на горячем пути стоит не только самого вызова, но и **аллокации объекта-метаданных** (`{ edits, maxChars, actualChars }`) на каждой итерации — даже если уровень debug выключен, объект всё равно создаётся. Решается на уровне бандлера через dead-code elimination по константе окружения:

```ts
// Паттерн dead-code elimination через константу окружения
if (process.env.NODE_ENV === 'development') {
  LOG.debug('recent edit diff tail built', { edits: recentEdits.length, maxChars, actualChars: tail.length });
}
// esbuild/terser в продакшне вырежет весь блок целиком, включая аллокацию объекта.
```

С этого момента применяем этот паттерн для всех `LOG.debug` на горячих путях: оборачиваем в `if (process.env.NODE_ENV === 'development')`, чтобы продакшн-сборка вырезала и вызов, и создание объекта-метаданных.

---

## 17. Спецификация smart-completions: фактическая архитектура

Этот раздел описывает текущую реализацию плагина `smart-completions`. При изменениях в коде сначала сверяйся с исходниками в `src/`; сгенерированный `lib/` не является источником истины.

### 17.1. DI и сервисы

Frontend-модуль: `src/browser/smart-completions-frontend-module.ts`.

Backend-модуль: `src/node/smart-completions-backend-module.ts`.

Плагин регистрирует три RPC-сервиса:

- `FimBackendService` по `FIM_SERVICE_PATH` — FIM ghost text.
- `NesBackendService` по `NES_SERVICE_PATH` — общий NES-фасад; для Sweep-моделей делегирует в `SweepBackendService`.
- `EmbeddingIndexService` по `EMBEDDING_SERVICE_PATH` — индексация, retrieval, статус индекса и тест соединений.

На frontend подключены:

- `FimInlineProvider` как Monaco inline completions provider.
- `SweepEditHistoryRecorder` как обязательный recorder истории правок.
- `NesController`, который сейчас является реэкспортом `SweepController` из `src/browser/nes-module/nes-controller.ts`.
- `NesViewZoneRenderer` как единственный renderer NES-подсказок.
- Sweep context sources: `WorkspaceFiles`, `SymbolSource`, `OutputSource`, `SearchRelatedSource`, `HierarchyRelatedSource`, `ScmChangedFilesSource`, `SweepContextCollector`.
- `EmbeddingConfigSync`, status bar и команды.

Важно: фактический frontend NES path сейчас Sweep-based. Legacy NES-builder на backend остаётся для не-Sweep моделей (`zeta`, `zeta-2.1`), но trigger/render реализованы через `SweepController` и View Zone.

### 17.2. Preferences

Схема настроек находится в `src/browser/preferences/preferences-schema.ts`.

Общее:

- `smart-completions.coordinationMode`: `exclusive-priority`, `parallel`, `fim-only`, `nes-only`, `nes-priority`; дефолт `exclusive-priority`.

FIM:

- `enabled`, `modelId`, `llamaUrl`, `contextSize`, `debounceMs`, `generationMode`, `temperature`, `ragEnabled`.
- `contextSources.recentEdits`, `contextSources.repoContext`, `contextSources.diagnostics` есть в schema, но backend сейчас реально использует только `repoContext`.
- `contextSize = 0` означает максимум выбранной FIM-модели из `FIM_CONTEXT_MAX`; backend клампит значение снизу до `1024`.
- `temperature` клампится backend в диапазон `0..0.1`.

NES/Sweep:

- `enabled`, `modelId`, `llamaUrl`, `sweepSmallSize`, `requestModelName`, `contextSize`, `debounceMs`, `editVolume`, `ragEnabled`, `injectInlineDiagnostics`, `relatedTopN`, `queryMaxChars`.
- `modelId`: `sweep-default`, `sweep-small`, `zeta`, `zeta-2.1`.
- `sweep-default` использует профиль `v2-7b`.
- `sweep-small` использует профиль `1.5b` или `0.5b` из `sweepSmallSize`.
- `requestModelName = ''` означает default model name из профиля Sweep.
- `contextSize` на backend клампится снизу до `1024`; эффективное окно также ограничено `profile.contextTokens`.

Embedding:

- `embedModel`, `llamaUrl`, `vectorDb`, `chromaUrl`, `indexOnSave`, `indexOnOpen`, `chunkSize`, `topN`, `prefixTailChars`.
- Алиасы `nomic` и `granite` резолвятся в `nomic-embed-text` и `granite-embedding`; неизвестное имя передаётся в llama.cpp как есть.
- `vectorDb`: `lancedb` или `chromadb`.

### 17.3. FIM

Frontend: `src/browser/fim-module/fim-inline-provider.ts`.

Backend: `src/node/services/fim-backend-service.ts`.

Prompt builder: `src/node/fim-module/context-formation/builder.ts`, `model-spec.ts`.

Поток выполнения:

1. `FimInlineProvider` регистрируется для Monaco inline completions на `file` и `untitled`.
2. При automatic trigger проверяется `shouldTrigger`.
3. В code mode автозапрос разрешён после `space`, `tab`, `newline`, `{`, `:`, `.` и не в середине слова.
4. В prose mode автозапрос разрешён после `space`, `newline`, `.`, `!`, `?` и не в середине слова.
5. Provider отправляет на backend `prefix`, `suffix`, `fileMode`, `languageId`, `uri`, `generationMode`.
6. Backend нормализует CRLF в LF.
7. Если модель поддерживает repo context, включён `ragEnabled` и `contextSources.repoContext`, backend делает retrieval по `prefix.slice(-prefixTailChars)`.
8. `buildFimPrompt` обрезает prefix/suffix через `trimFimContext` с учётом `contextSize`, `fileMode` и retrieved chunks.
9. Базовый prompt: `{prefixToken}{prefix}{suffixToken}{suffix}{middleToken}`.
10. Repo-level prompt включается только при наличии реальных retrieval-соседей.
11. llama.cpp вызывается через raw `/completions`; ответ проходит `postprocessFimCompletion`.

FIM токены:

- Qwen 2.5 Coder и OmniCoder: `<|fim_prefix|>`, `<|fim_suffix|>`, `<|fim_middle|>`, repo token `<|repo_name|>`, file token `<|file_sep|>`.
- DeepSeek Coder: `<｜fim▁begin｜>`, `<｜fim▁hole｜>`, `<｜fim▁end｜>`, repo context не поддерживается.
- Granite 4.1 8B/3B: `<|fim_prefix|>`, `<|fim_suffix|>`, `<|fim_middle|>`, repo token `<|reponame|>`, file token `<|filename|>`.

FIM stop tokens формируются из FIM-токенов модели и `extraStops`. Одиночный `\n` не используется как серверный stop token: модели часто выдают ведущий перевод строки, и stop по `\n` обрезает ответ в пустую строку. Однострочный режим делается в postprocess.

`generationMode` задаёт `maxTokens`: `line = 48`, `multiline = 160`, `block = 384`.

### 17.4. Embedding/RAG

Ядро: `src/node/embedding-module/embedding-service.ts`.

Retrieval: `src/node/embedding-module/retriever/hybrid-retriever.ts`.

Поток выполнения:

1. `EmbeddingConfigSync` синхронизирует preferences с backend.
2. `EmbeddingService.configure` создаёт workspace-specific storage dir по `md5(roots.join('|') || 'default')`.
3. Создаются `LlamaEmbedClient`, выбранный `VectorStore`, новый `Bm25Index`, `HybridRetriever`, `RepoIndexer`, `IndexPersistence`.
4. Для LanceDB используется локальная директория `lancedb` внутри workspace storage.
5. Для ChromaDB используется `chromaUrl`.
6. `retrieve(queryText, topN)` выполняет гибридный поиск.

Hybrid retrieval:

- Векторная ветка получает embedding через llama.cpp и ищет `topN * 2` в vector store.
- BM25 ищет `topN * 2` лексически.
- Результаты сливаются через Reciprocal Rank Fusion с `k = 60`.
- При сбое embedding/vector ветки retrieval деградирует до BM25 и не блокирует подсказку.

Для FIM query = хвост prefix. Для Sweep NES query строится из edit-сигналов и хвоста diff-истории.

### 17.5. Координация FIM и NES

Фактические режимы читаются из `smart-completions.coordinationMode`.

- `fim-only`: Sweep/NES trigger не планируется.
- `nes-only`: FIM provider не отдаёт inline completions.
- `exclusive-priority`: Sweep trigger пропускается, если после последнего изменения прошло меньше `debounceMs`.
- `parallel` и `nes-priority` есть в schema, но в текущем коде SweepController не содержит отдельной логики для них, кроме отсутствия `fim-only` gating; FIM отдельно блокируется только режимом `nes-only`.

NES всегда рендерится через View Zone, FIM — через Monaco inline ghost text. Отдельного арбитра нет.

### 17.6. NES render

Renderer: `src/browser/nes-render/nes-view-zone-renderer.ts`.

NES-подсказка отображается как Monaco View Zone под первой строкой `primaryRange`. Перед показом renderer удаляет старую View Zone, поэтому активна только одна NES-подсказка.

View Zone содержит заголовок `Next edit suggestion · {modelId} · Alt+Tab jump/accept · Esc dismiss` и preview `newText`. Высота ограничена диапазоном `3..12` строк.

Действия:

- `accept()` применяет `TextEditDTO[]` через `editor.executeEdits('smart-completions-nes', ...)`, затем прыгает в `jumpTo`, если он задан.
- `dismiss()` удаляет View Zone и сбрасывает состояние.
- `jumpOrAccept()` сначала переносит курсор к `jumpTo`; если курсор уже там, принимает правку.

---

## 18. Sweep Next Edit Suggestions

Sweep NES реализован отдельным пайплайном `src/browser/sweep/*` и `src/node/sweep/*`. Это основной NES-путь для `sweep-default` и `sweep-small`.

### 18.1. Модели и профили

Профили находятся в `src/common/sweep/profiles.ts`.

`sweep-default`:

- profile id: `v2-7b`.
- default llama model: `sweep-next-edit-v2-7B`.
- context tokens: `32768`.
- broad file lines: `300`.
- triad window: `10` строк до курсора и `10` после.
- max output tokens: `1024`.
- temperature: `0`.

`sweep-small`, `sweepSmallSize = 1.5b`:

- default llama model: `sweep-next-edit-1.5B`.
- context tokens: `8192`.
- broad file lines: `160`.
- triad window: `10` строк до курсора и `10` после.
- max output tokens: `768`.
- temperature: `0`.

`sweep-small`, `sweepSmallSize = 0.5b`:

- default llama model: `sweep-next-edit-0.5B`.
- context tokens: `8192`.
- broad file lines: `100`.
- triad window: `8` строк до курсора и `8` после.
- max output tokens: `512`.
- temperature: `0`.

`editVolume` задаёт `maxTokens`: `small = min(profile.maxOutputTokens, 384)`, `medium = min(profile.maxOutputTokens, 768)`, `large = profile.maxOutputTokens`.

### 18.2. Условие запуска

Trigger controller: `src/browser/sweep/trigger-layer/sweep-controller.ts`.

Sweep запускается после событий изменения контента или позиции курсора через debounce `config.debounceMs`. При каждом изменении контента renderer скрывает старую подсказку.

Sweep не запускается если:

- `smart-completions.nes.enabled = false`.
- `coordinationMode = fim-only`.
- нет active model или позиции курсора.
- в режиме `exclusive-priority` с момента последнего изменения прошло меньше `debounceMs`.
- нет недавних правок в `SweepEditHistoryRecorder`.
- текущий запрос отменён или версия Monaco-модели изменилась между snapshot, context collection и ответом backend.
- backend вернул пустой список edits.

Перед новым запросом текущий in-flight запрос отменяется через `CancellationTokenSource`; backend переводит Theia cancellation token в `AbortSignal`.

### 18.3. История правок как обязательный источник

Recorder: `src/browser/sweep/data-gathering-layer/sweep-edit-history-recorder.ts`.

Core store: `src/common/sweep/edit-history-store.ts`.

История правок обязательна: если `getRecentEdits(..., 8)` возвращает пустой список, `SweepRequestBuilder.snapshot` возвращает `undefined`, и NES-цикл останавливается до сбора дополнительного контекста и вызова модели.

Как пишется история:

1. `SweepEditHistoryRecorder` подписывается на существующие Monaco-модели и на создание новых.
2. На `onDidChangeContent` вызывается `EditHistoryStore.scheduleRecord(uri)`.
3. Store не строит diff на каждый keystroke: запись отложена на `RECORD_DEBOUNCE_MS = 250`.
4. При чтении истории срабатывает flush-on-read: pending изменения материализуются до возврата результата.
5. История глобальная, не фильтруется по текущему uri.
6. Буфер ограничен `MAX_HISTORY = 40`, а snapshot берёт последние `8` записей.
7. Каждый `RecentEdit` содержит `uri`, `unifiedDiff`, `timestamp`.
8. `unifiedDiff` компактный: общий prefix/suffix строк выкидывается, остаётся изменённый диапазон с `---`, `+++`, `@@`, `-`, `+`.
9. Store хранит `preEditText` — снимок документа до последней правки для блока `original/`.

Если exact `originalWindowText` для текущего диапазона не найден, frontend пытается восстановить original window через `reconstructOriginalWindow`. Если восстановить не удалось, backend использует текущее окно как fallback.

### 18.4. Snapshot редактора

Builder: `src/browser/sweep/data-formatting-layer/sweep-request-builder.ts`.

В snapshot попадают:

- `windowText` — окно для final triad `original/current/updated`.
- `windowStart` — 0-based позиция начала окна.
- `windowLineCount`.
- `broadFileText` — широкий блок текущего файла.
- `broadFileStartLine`.
- `originalWindowText` — окно до последней правки или восстановленное окно.
- `cursorOffset` — offset курсора внутри `windowText`.
- `recentEdits` — последние 8 diff-ов.
- `diagnostics` — до 20 Monaco markers текущей модели.

Окно triad:

- В code mode берутся фиксированные строки `windowBefore/windowAfter` вокруг курсора.
- В prose mode окно расширяется до границ абзаца: вверх и вниз до пустых строк.

`broadFileText` берётся вокруг позиции курсора с размером `profile.broadFileLines`. Диагностики преобразуются в `DiagnosticDTO`: 0-based range, severity, message, optional code.

### 18.5. Дополнительный контекст

Collector: `src/browser/sweep/data-gathering-layer/sweep-context-collector.ts`.

Collector запускает best-effort источники. Ошибка отдельного источника логируется и не прерывает Sweep-цикл.

Источники:

- `SymbolSource` строит outline текущего файла.
- `HierarchyRelatedSource` собирает related candidates через LSP call/type hierarchy.
- `SearchRelatedSource` ищет связанные файлы по workspace search.
- `ScmChangedFilesSource` добавляет dirty/changed files как co-change сигнал.
- `OutputSource` берёт snippets из Output channels.
- `WorkspaceFiles` читает окна файлов и нормализует пути относительно workspace.

Related-file queries строятся из edit-сигналов:

- символ под курсором.
- символы, появившиеся или исчезнувшие в recent edit diffs.
- символы из диагностик.
- imported symbols из текущего окна.
- объявленные типы (`interface`, `class`, `type`, `enum`, `struct`).
- имена тестов из `describe`, `it`, `test`.

Candidates из hierarchy/search/scm дедуплицируются и ранжируются через `dedupeRankRelated`, затем ограничиваются `relatedTopN`. Output snippets не добавляются, если среди диагностик есть `error`.

### 18.6. Sweep RAG retrieval на backend

Backend: `src/node/sweep/sweep-backend-service.ts`.

Если `ragEnabled = true`, backend строит retrieval query через `buildSweepRetrievalQuery` и вызывает `EmbeddingIndexServiceImpl.retrieve(query, topN)`.

Retrieval query состоит из:

- `symbolAtCursor(windowText, cursorOffset)`.
- `renamedSymbols(recentEdits)`.
- `diagnosticSymbols(diagnostics)`.
- `importedSymbols(windowText)`.
- `declaredTypeNames(windowText)`.
- `testNames(windowText)`.
- хвост recent edit diff-ов через `recentEditDiffTail(recentEdits, maxChars)`.

`maxChars` берётся из `config.queryMaxChars`; если он пустой/нулевой, используется `embedding.prefixTailChars`. Если query пустой, retrieval пропускается. RAG-соседи вставляются в prompt как нативные file blocks `<|file_sep|>{filePath}\n{text}`.

### 18.7. Обрезка контекста

Trimmer: `src/node/sweep/data-formatting-layer/context-trimmer.ts`.

Token budget:

```text
reserved = maxTokens + 128
effectiveContext = min(config.contextSize, profile.contextTokens)
budget = max(256, effectiveContext - reserved)
windowBudget = floor(budget * 0.4)
```

Перед сборкой prompt backend вызывает `QwenTokenCounter.ensureReady()`. Если tokenizer недоступен, используется char fallback.

Приоритет обрезки:

1. `windowText` нормализуется CRLF→LF и клампится вокруг курсора в `windowBudget`.
2. `originalWindowText` нормализуется; если его нет, используется clamped current window.
3. `prefill` по умолчанию = часть `windowText` от начала окна до начала строки с курсором.
4. `diagnosticsEnabled = fileMode !== 'prose' && injectInlineDiagnostics !== false`.
5. `remaining` уменьшается на current window, original window и prefill.
6. `broadFileText` получает до `55%` оставшегося бюджета.
7. Error diagnostics добавляются первыми.
8. Recent edits сортируются от новых к старым для обрезки: более новые сохраняются первыми.
9. RAG neighbors сортируются по score по убыванию.
10. Related files добавляются в переданном порядке.
11. Warning diagnostics добавляются после related context.
12. Outline добавляется, если помещается целиком.
13. Output snippets добавляются последними.

При форматировании diff blocks recent edits снова сортируются хронологически от старых к новым. `overflow = true`, если clamped window пустой или бюджет ушёл в минус; backend тогда возвращает пустой NES-ответ без llama.cpp.

### 18.8. Нативный Sweep prompt format

Prompt builder: `src/node/sweep/prompt-creating-layer/sweep-prompt-builder.ts`.

Формат prompt — strict training-format. Блоки соединяются одиночным `\n`. Служебный разделитель: `<|file_sep|>`.

Порядок секций:

1. Широкий блок текущего файла, если есть `broadFileText`.
2. RAG neighbor file blocks.
3. Related file blocks от frontend-источников.
4. `outline/{filePath}` псевдофайл.
5. `diagnostics/{filePath}` псевдофайл.
6. `output/{channel}` псевдофайлы.
7. `{path}.diff` блоки recent edits.
8. `original/{filePath}:{range}`.
9. `current/{filePath}:{range}` с `<|cursor|>` внутри текста.
10. `updated/{filePath}:{range}` с prefill; это последний блок prompt, после него модель генерирует continuation.

Шаблон:

```text
<|file_sep|>{currentFilePath}
{broadFileText}
<|file_sep|>{ragNeighborPath}
{ragNeighborText}
<|file_sep|>{relatedFilePath}
{relatedFileText}
<|file_sep|>outline/{currentFilePath}
{outlineText}
<|file_sep|>diagnostics/{currentFilePath}
Line {lineNumber}: {diagnosticMessage}
<|file_sep|>output/{channel}
{outputText}
<|file_sep|>{recentEditPath}.diff
original:
{originalStateFromDiff}
updated:
{updatedStateFromDiff}
<|file_sep|>original/{currentFilePath}:{startLine}:{endLine}
{originalWindowText}
<|file_sep|>current/{currentFilePath}:{startLine}:{endLine}
{windowTextBeforeCursor}<|cursor|>{windowTextAfterCursor}
<|file_sep|>updated/{currentFilePath}:{startLine}:{endLine}
{prefill}
```

Заполняемые токены и слоты:

- `<|file_sep|>` — разделяет file/pseudo-file blocks и является stop token.
- `{currentFilePath}` — workspace-relative path текущего файла.
- `{ragNeighborPath}` / `{ragNeighborText}` — chunks из embedding retrieval.
- `{relatedFilePath}` / `{relatedFileText}` — файлы от LSP hierarchy, workspace search и SCM.
- `outline/{currentFilePath}` — outline текущего файла.
- `diagnostics/{currentFilePath}` — diagnostics текущего файла, строки `Line N: message`, errors before warnings.
- `output/{channel}` — output channel snippets.
- `{recentEditPath}.diff` — workspace-relative путь recent edit плюс `.diff`.
- `original:` и `updated:` внутри diff block — состояния, полученные из unified diff.
- `original/{currentFilePath}:{range}` — старое состояние окна перед последней правкой или fallback.
- `current/{currentFilePath}:{range}` — текущее окно с `<|cursor|>`.
- `<|cursor|>` — точная позиция курсора.
- `updated/{currentFilePath}:{range}` — префикс целевого нового окна; модель продолжает этот блок.

`range` в triad заголовках — 1-based `start:end`, где `start = windowStartLine + 1`, `end = windowStartLine + lineCount(windowText)`.

### 18.9. Recent edit diff blocks

Formatter: `src/node/sweep/data-formatting-layer/diff-blocks.ts`.

История хранится как unified diff, но Sweep prompt использует блоки состояний:

```text
<|file_sep|>{edit.uri}.diff
original:
{lines_before_change}
updated:
{lines_after_change}
```

Преобразование:

- строки `---`, `+++`, `@@`, `Index:`, `===` игнорируются.
- строки с `-` попадают только в `original` без первого символа.
- строки с `+` попадают только в `updated` без первого символа.
- строки с пробелом попадают в оба состояния без первого символа.
- остальные строки попадают в оба состояния как есть.

Перед форматированием diff blocks сортируются от старых к новым.

### 18.10. Diagnostics и injectInlineDiagnostics

В текущем Sweep path diagnostics попадают в prompt не inline-вставкой в code window, а отдельным псевдофайлом `diagnostics/{filePath}`.

`injectInlineDiagnostics` фактически управляет включением diagnostics для общего Sweep trimmer:

```ts
const diagnosticsEnabled = input.fileMode !== 'prose' && input.injectInlineDiagnostics !== false;
```

Следствия текущей реализации:

- Default preference `smart-completions.nes.injectInlineDiagnostics = false`, поэтому diagnostics по умолчанию не попадают в Sweep prompt.
- Если пользователь выставил `true`, diagnostics включаются для Sweep в code mode.
- В prose mode diagnostics всегда отключены.
- Логика не ограничена только `sweep-small`: `SweepBackendService` передаёт поле в общий Sweep builder.

Если нужно строгое поведение «только для sweep-small», надо менять код, а не только спецификацию.

### 18.11. Вызов llama.cpp

Client: `src/node/sweep/model-call-layer/llama-sweep-client.ts`.

Sweep использует raw completion endpoint:

```http
POST {llamaUrl}/completions
```

Body:

```json
{
  "model": "{requestModelName или default profile model}",
  "prompt": "{training-format prompt}",
  "max_tokens": 384,
  "temperature": 0,
  "stop": ["<|file_sep|>", "<|endoftext|>"],
  "cache_prompt": true,
  "seed": 0,
  "stream": false
}
```

Фактические `max_tokens` зависят от `editVolume` и профиля. При HTTP `503` клиент делает один retry: ждёт `Retry-After` или `200ms`; ожидание прерывается через `AbortSignal`.

### 18.12. Парсинг ответа и reject gates

Parser: `src/node/sweep/model-call-layer/sweep-response-parser.ts`.

Reject gates: `src/node/sweep/model-call-layer/reject-gates.ts`.

Парсинг:

1. Сырой ответ нормализуется CRLF→LF.
2. Удаляются `<|cursor|>` и `<|file_sep|>`.
3. Ответ обрезается по stop tokens `<|file_sep|>` и `<|endoftext|>`.
4. `updatedWindow = prefill + cleanedResponse`, если prefill есть.
5. Пустой ответ или `NO_EDITS` возвращает пустой список edits.
6. `diffWindows(oldWindowText, updatedWindow, windowStart)` вычисляет минимальный line-based replacement через общий prefix/suffix.
7. Edit прогоняется через reject gates.
8. Успешный результат возвращается как один `TextEditDTO`, `primaryRange = edit.range`, `jumpTo = edit.range.start`.

Reject gates отбрасывают:

- whitespace-only изменения.
- резкое изменение формы окна: слишком большой рост строк или сжатие меньше 25% исходного окна.
- pure insertion строго выше строки курсора без изменения строки курсора.
- слишком большой edit volume: затронуто больше `max(12, ceil(oldLineCount * 0.75))` строк.

### 18.13. Legacy NES для не-Sweep моделей

`NesBackendServiceImpl` содержит legacy path через `src/node/nes-module/context-formation/builder.ts`, `LlamaNesClient` и `parseNesCompletion`. Этот путь используется только если `modelId` не `sweep-default` и не `sweep-small`.

Frontend controller при этом всё равно Sweep-based: он собирает `SweepRequest`-совместимый набор данных и отправляет его через общий `NesBackendService.predict`. При изменении Zeta/legacy NES нужно проверять совместимость типов `NesRequest` и `SweepRequest`.

