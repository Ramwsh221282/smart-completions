// Frontend contribution: mirrors Monaco models into the Rust core shadow store.
// Only activates when the core reports it is enabled, so the disabled path adds
// zero per-keystroke RPC overhead.

import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { Disposable, DisposableCollection } from '@theia/core/lib/common';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { CoreBackendService } from '../../common/core/core-protocol';
import { toCoreDocumentChange, toCoreInitialSnapshot } from './document-sync-mapping';

@injectable()
export class CoreDocumentSyncContribution implements FrontendApplicationContribution, Disposable {
    @inject(CoreBackendService)
    protected readonly core!: CoreBackendService;
    @inject(WorkspaceService)
    protected readonly workspace!: WorkspaceService;

    private readonly toDispose = new DisposableCollection();
    private readonly modelDisposables = new Map<string, DisposableCollection>();

    onStart(): void {
        void this.startIfEnabled();
    }

    dispose(): void {
        this.toDispose.dispose();
        for (const disposable of this.modelDisposables.values()) {
            disposable.dispose();
        }
        this.modelDisposables.clear();
    }

    private async startIfEnabled(): Promise<void> {
        const status = await this.core.getStatus().catch(() => undefined);
        if (!status?.enabled) {
            return;
        }

        for (const model of monaco.editor.getModels()) {
            this.trackModel(model);
        }
        this.toDispose.push(monaco.editor.onDidCreateModel(model => this.trackModel(model)));
    }

    private trackModel(model: monaco.editor.ITextModel): void {
        const uri = model.uri.toString();
        if (this.modelDisposables.has(uri)) {
            return;
        }

        void this.core.syncInitialDocument(this.snapshotOf(model));

        const disposable = new DisposableCollection();
        disposable.push(model.onDidChangeContent(event => this.onContentChange(model, event)));
        disposable.push(model.onWillDispose(() => this.untrackModel(uri)));
        this.modelDisposables.set(uri, disposable);
    }

    private onContentChange(
        model: monaco.editor.ITextModel,
        event: monaco.editor.IModelContentChangedEvent,
    ): void {
        const change = toCoreDocumentChange(model.uri.toString(), event.versionId, event.changes);
        void this.core.applyDocumentChange(change);
    }

    private untrackModel(uri: string): void {
        this.modelDisposables.get(uri)?.dispose();
        this.modelDisposables.delete(uri);
    }

    private snapshotOf(model: monaco.editor.ITextModel) {
        return toCoreInitialSnapshot({
            uri: model.uri.toString(),
            version: model.getVersionId(),
            languageId: model.getLanguageId(),
            scheme: model.uri.scheme,
            filePath: this.relativeFilePath(model.uri.toString()),
            text: model.getValue(),
        });
    }

    private relativeFilePath(uri: string): string | undefined {
        const target = new URI(uri);
        const roots = this.workspace.tryGetRoots();
        for (let i = 0; i < roots.length; i++) {
            const relative = roots[i].resource.relative(target);
            if (relative) {
                return relative.toString();
            }
        }
        return undefined;
    }
}
