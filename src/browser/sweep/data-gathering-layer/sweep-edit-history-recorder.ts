import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { Disposable, DisposableCollection } from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import { RecentEdit } from '../../../common/edit-history-types';
import { EditHistoryStore } from '../../../common/sweep/edit-history-store';
import { SweepLogger } from '../../../common/sweep/logger';

// Логгер адаптера; нужен для диагностики жизненного цикла трекинга Monaco-моделей.
const LOG = new SweepLogger('browser:data-gathering:edit-history');

// Реэкспорт для обратной совместимости импортов; сама реализация диффа живёт в monaco-free ядре.
export { formatSweepUnifiedDiff } from '../../../common/sweep/edit-history-store';

/**
 * Тонкий Monaco-адаптер над EditHistoryStore.
 *
 * Подписывается на события Monaco-моделей и транслирует их в monaco-free ядро истории правок.
 * Вся логика debounce/flush/diff живёт в EditHistoryStore — здесь только проводка событий редактора.
 */
@injectable()
export class SweepEditHistoryRecorder implements FrontendApplicationContribution, Disposable {
    // Подписки уровня приложения; освобождаются при dispose чтобы не удерживать ссылки.
    private readonly toDispose = new DisposableCollection();
    // По одному DisposableCollection на каждую модель; позволяет точечно отписаться при закрытии файла.
    private readonly modelDisposables = new Map<string, DisposableCollection>();
    // Monaco-free ядро: хранит историю, debounce-таймеры и снимки до правки.
    private readonly store = new EditHistoryStore();

    /**
     * Подключает трекинг ко всем уже открытым моделям и подписывается на создание новых,
     * чтобы история правок начала накапливаться с первого момента работы пользователя.
     */
    onStart(): void {
        for (const model of monaco.editor.getModels()) {
            this.trackModel(model);
        }
        this.toDispose.push(monaco.editor.onDidCreateModel(model => this.trackModel(model)));
        LOG.info('Sweep edit history recorder started', { models: monaco.editor.getModels().length });
    }

    /**
     * Делегирует чтение свежих диффов ядру; сигнатура с uri сохранена для существующих вызовов,
     * хотя история глобальна и фильтрация по uri не требуется.
     */
    getRecentEdits(_uri?: string, limit = 8): RecentEdit[] {
        return this.store.getRecentEdits(limit);
    }

    /**
     * Делегирует ядру срез документа до последней правки для блока original/ Sweep-промпта.
     */
    getWindowBeforeLastEdit(uri: string, startLine0: number, endLine0: number): string | undefined {
        return this.store.getWindowBeforeLastEdit(uri, startLine0, endLine0);
    }

    /**
     * Освобождает Monaco-подписки и сбрасывает ядро, чтобы рекордер не удерживал модели и таймеры.
     */
    dispose(): void {
        this.toDispose.dispose();
        for (const disposable of this.modelDisposables.values()) {
            disposable.dispose();
        }
        this.modelDisposables.clear();
        this.store.dispose();
        LOG.info('Sweep edit history recorder disposed');
    }

    /**
     * Регистрирует модель в ядре и проводит её события: изменение контента → debounce-запись,
     * закрытие → untrack. Идемпотентен, чтобы повторное открытие файла не дублировало подписки.
     */
    private trackModel(model: monaco.editor.ITextModel): void {
        const uri = model.uri.toString();
        if (this.modelDisposables.has(uri)) {
            return;
        }
        this.store.track({ uri, getValue: () => model.getValue() });
        const disposable = new DisposableCollection();
        disposable.push(model.onDidChangeContent(() => this.store.scheduleRecord(uri)));
        disposable.push(model.onWillDispose(() => {
            this.store.untrack(uri);
            this.modelDisposables.get(uri)?.dispose();
            this.modelDisposables.delete(uri);
        }));
        this.modelDisposables.set(uri, disposable);
    }
}
