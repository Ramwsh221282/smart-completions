import { injectable, inject } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { PreferenceService, PreferenceChange } from '@theia/core/lib/common/preferences/preference-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileChangesEvent } from '@theia/filesystem/lib/common/files';
import * as monaco from '@theia/monaco-editor-core';
import { EmbeddingIndexService, SweepGraphService } from '../../common/protocol';
import { readEmbeddingConfig, readNesConfig } from '../preferences/preferences-schema';

/**
 * Синхронизация настроек/корней воркспейса с backend embedding-сервисом
 * и инкрементальный reindex по сохранению/изменению файлов.
 */
@injectable()
export class EmbeddingConfigSync implements FrontendApplicationContribution {
    @inject(EmbeddingIndexService) private readonly indexService!: EmbeddingIndexService;
    @inject(SweepGraphService) private readonly sweepGraph!: SweepGraphService;
    @inject(PreferenceService) private readonly preferences!: PreferenceService;
    @inject(WorkspaceService) private readonly workspace!: WorkspaceService;
    @inject(FileService) private readonly fileService!: FileService;

    async onStart(): Promise<void> {
        await this.push();
        this.preferences.onPreferenceChanged((e: PreferenceChange) => {
            if (this.shouldPush(e.preferenceName)) {
                void this.push();
            }
        });
        this.workspace.onWorkspaceChanged(() => void this.push());
        this.fileService.onDidFilesChange(event => this.onFilesChanged(event));
    }

    private async push(): Promise<void> {
        const config = readEmbeddingConfig(this.preferences);
        const nesConfig = readNesConfig(this.preferences);
        const roots = this.workspace.tryGetRoots().map(stat => stat.resource.toString());
        try {
            await this.indexService.configure(config, roots);
            await this.sweepGraph.configure(roots, this.isSweepGraphEnabled(nesConfig));
        } catch {
            /* backend ещё не готов — повтор на следующем изменении */
        }
    }

    private onFilesChanged(event: FileChangesEvent): void {
        if (!this.preferences.get<boolean>('smart-completions.embedding.indexOnSave', true)) {
            return;
        }
        for (const change of event.changes) {
            const uri = change.resource.toString();
            void this.indexService.reindexFile(uri).catch(() => undefined);
            if (!this.isOpenModel(uri) && this.isSweepGraphEnabled(readNesConfig(this.preferences))) {
                void this.sweepGraph.reindexFile(uri).catch(() => undefined);
            }
        }
    }

    private shouldPush(preferenceName: string): boolean {
        return preferenceName.startsWith('smart-completions.embedding')
            || preferenceName.startsWith('smart-completions.nes.graph')
            || preferenceName.startsWith('smart-completions.nes.fuzzy')
            || preferenceName === 'smart-completions.nes.modelId';
    }

    private isSweepGraphEnabled(config: ReturnType<typeof readNesConfig>): boolean {
        return (config.modelId === 'sweep-default' || config.modelId === 'sweep-small') && (config.graph.enabled || config.fuzzy.enabled);
    }

    private isOpenModel(uri: string): boolean {
        try {
            return monaco.editor.getModel(monaco.Uri.parse(uri)) !== null;
        } catch {
            return false;
        }
    }
}
