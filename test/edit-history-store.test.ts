import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditHistoryStore, EditHistoryModel, MAX_HISTORY, RECORD_DEBOUNCE_MS } from '../src/common/sweep/edit-history-store';

// Изменяемая фейковая модель: getValue возвращает текущее значение, set меняет его между событиями.
function fakeModel(uri: string, value: string): EditHistoryModel & { set(v: string): void } {
    let current = value;
    return { uri, getValue: () => current, set: (v: string) => { current = v; } };
}

test('debounce collapses a burst of changes into a single diff', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new EditHistoryStore(RECORD_DEBOUNCE_MS);
    const model = fakeModel('file:///a.ts', 'a\nb\n');
    store.track(model);

    model.set('a\nB1\n');
    store.scheduleRecord(model.uri);
    model.set('a\nB2\n');
    store.scheduleRecord(model.uri);

    // До истечения паузы запись не выполнена; единственный таймер после reschedule срабатывает один раз.
    t.mock.timers.tick(RECORD_DEBOUNCE_MS);

    const edits = store.getRecentEdits(8);
    assert.equal(edits.length, 1, 'burst collapses into one edit, not one per keystroke');
    assert.ok(edits[0].unifiedDiff.includes('B2'), 'diff reflects the final burst state');
    assert.ok(edits[0].unifiedDiff.includes('-b'), 'diff reflects the pre-burst baseline');
});

test('flush-on-read records a pending change before the debounce elapses', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new EditHistoryStore(RECORD_DEBOUNCE_MS);
    const model = fakeModel('file:///b.ts', 'x\ny\n');
    store.track(model);

    model.set('x\nY\n');
    store.scheduleRecord(model.uri);

    // Читаем БЕЗ продвижения таймеров: getRecentEdits обязан материализовать отложенную правку.
    const edits = store.getRecentEdits(8);
    assert.equal(edits.length, 1, 'read forces a flush of the pending change');
    assert.ok(edits[0].unifiedDiff.includes('Y'), 'flushed diff captures the change');
});

test('getWindowBeforeLastEdit flushes pending and returns the pre-edit snapshot', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new EditHistoryStore(RECORD_DEBOUNCE_MS);
    const model = fakeModel('file:///c.ts', 'a\nb\nc\n');
    store.track(model);

    model.set('a\nB\nc\n');
    store.scheduleRecord(model.uri);

    // Без тика: getWindowBeforeLastEdit должен флашнуть и вернуть состояние ДО правки (старая 'b').
    const window = store.getWindowBeforeLastEdit(model.uri, 0, 2);
    assert.equal(window, 'a\nb\nc', 'original window reflects pre-edit text');
});

test('a no-op change records nothing', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new EditHistoryStore(RECORD_DEBOUNCE_MS);
    const model = fakeModel('file:///d.ts', 'same');
    store.track(model);

    // Значение не менялось — scheduleRecord не должен породить запись.
    store.scheduleRecord(model.uri);
    assert.equal(store.getRecentEdits(8).length, 0, 'identical before/after produces no edit');
});

test('history is capped at MAX_HISTORY (ring buffer)', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new EditHistoryStore(RECORD_DEBOUNCE_MS);
    const model = fakeModel('file:///e.ts', 'v0');
    store.track(model);

    const total = MAX_HISTORY + 5;
    for (let i = 1; i <= total; i++) {
        model.set(`v${i}`);
        store.scheduleRecord(model.uri);
        store.getRecentEdits(1); // flush-on-read фиксирует каждую правку
    }

    const all = store.getRecentEdits(10_000);
    assert.equal(all.length, MAX_HISTORY, 'ring buffer never exceeds MAX_HISTORY');
    assert.ok(all[all.length - 1].unifiedDiff.includes(`v${total}`), 'newest edit is retained');
});
