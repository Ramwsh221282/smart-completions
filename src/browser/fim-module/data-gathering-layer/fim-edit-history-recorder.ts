import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { Disposable, DisposableCollection } from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import type { RecentEdit } from '../../../common/edit-history-types';
import { FimLogger } from '../../../common/fim/logger';
import { EditHistoryStore } from '../../../common/sweep/edit-history-store';

const LOG = new FimLogger('browser:data-gathering:edit-history');

@injectable()
export class FimEditHistoryRecorder implements FrontendApplicationContribution, Disposable {
    private readonly toDispose = new DisposableCollection();
    private readonly modelDisposables = new Map<string, DisposableCollection>();
    private readonly store = new EditHistoryStore();

    onStart(): void {
        for (const model of monaco.editor.getModels()) {
            this.trackModel(model);
        }
        this.toDispose.push(monaco.editor.onDidCreateModel(model => this.trackModel(model)));
        LOG.info('FIM edit history recorder started', { models: monaco.editor.getModels().length });
    }

    getRecentEdits(_uri?: string, limit = 8): RecentEdit[] {
        return this.store.getRecentEdits(limit);
    }

    dispose(): void {
        this.toDispose.dispose();
        for (const disposable of this.modelDisposables.values()) {
            disposable.dispose();
        }
        this.modelDisposables.clear();
        this.store.dispose();
        LOG.info('FIM edit history recorder disposed');
    }

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
