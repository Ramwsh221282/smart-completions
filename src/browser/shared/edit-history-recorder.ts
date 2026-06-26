import { injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { Disposable, DisposableCollection } from '@theia/core/lib/common';
import * as monaco from '@theia/monaco-editor-core';
import { RecentEdit } from '../../common/edit-history-types';

const MAX_HISTORY = 40;

@injectable()
export class EditHistoryRecorder implements FrontendApplicationContribution, Disposable {
    private readonly toDispose = new DisposableCollection();
    private readonly modelDisposables = new Map<string, DisposableCollection>();
    private readonly previousText = new Map<string, string>();
    /** Текст документа непосредственно ДО последней зафиксированной правки (для original/ окна). */
    private readonly preEditText = new Map<string, string>();
    private readonly history: RecentEdit[] = [];

    onStart(): void {
        for (const model of monaco.editor.getModels()) {
            this.trackModel(model);
        }
        this.toDispose.push(monaco.editor.onDidCreateModel(model => this.trackModel(model)));
    }

    getRecentEdits(_uri?: string, limit = 8): RecentEdit[] {
        return this.history.slice(-limit);
    }

    /**
     * Окно документа в состоянии ДО последней правки (тот же диапазон строк, что и текущее окно).
     * Возвращает undefined, если снимка нет — тогда original/ совпадёт с current/.
     */
    getWindowBeforeLastEdit(uri: string, startLine0: number, endLine0: number): string | undefined {
        const before = this.preEditText.get(uri);
        if (before === undefined) {
            return undefined;
        }
        const lines = before.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        return lines.slice(Math.max(0, startLine0), Math.max(0, endLine0) + 1).join('\n');
    }

    dispose(): void {
        this.toDispose.dispose();
        for (const disposable of this.modelDisposables.values()) {
            disposable.dispose();
        }
        this.modelDisposables.clear();
    }

    private trackModel(model: monaco.editor.ITextModel): void {
        const uri = model.uri.toString();
        if (this.modelDisposables.has(uri)) {
            return;
        }
        const disposable = new DisposableCollection();
        this.previousText.set(uri, model.getValue());
        disposable.push(model.onDidChangeContent(() => this.recordChange(model)));
        disposable.push(model.onWillDispose(() => {
            this.previousText.delete(uri);
            this.preEditText.delete(uri);
            this.modelDisposables.get(uri)?.dispose();
            this.modelDisposables.delete(uri);
        }));
        this.modelDisposables.set(uri, disposable);
    }

    private recordChange(model: monaco.editor.ITextModel): void {
        const uri = model.uri.toString();
        const before = this.previousText.get(uri) ?? '';
        const after = model.getValue();
        this.previousText.set(uri, after);
        if (before === after) {
            return;
        }
        const unifiedDiff = formatUnifiedDiff(uri, before, after);
        if (!unifiedDiff) {
            return;
        }
        this.preEditText.set(uri, before);
        this.history.push({ uri, unifiedDiff, timestamp: Date.now() });
        while (this.history.length > MAX_HISTORY) {
            this.history.shift();
        }
    }
}

export function formatUnifiedDiff(uri: string, before: string, after: string): string {
    const oldLines = before.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const newLines = after.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
        prefix++;
    }
    let suffix = 0;
    while (
        suffix < oldLines.length - prefix &&
        suffix < newLines.length - prefix &&
        oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
        suffix++;
    }
    if (prefix === oldLines.length && prefix === newLines.length) {
        return '';
    }
    const oldChanged = oldLines.slice(prefix, oldLines.length - suffix);
    const newChanged = newLines.slice(prefix, newLines.length - suffix);
    return [
        `--- ${uri}`,
        `+++ ${uri}`,
        `@@ -${prefix + 1},${oldChanged.length} +${prefix + 1},${newChanged.length} @@`,
        ...oldChanged.map(line => `-${line}`),
        ...newChanged.map(line => `+${line}`),
    ].join('\n');
}
