import { injectable, inject } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { PreferenceService, PreferenceChange } from '@theia/core/lib/common/preferences/preference-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileChangesEvent } from '@theia/filesystem/lib/common/files';
import { EmbeddingIndexService } from '../../common/protocol';
import { readEmbeddingConfig } from '../preferences/preferences-schema';

/**
 * Синхронизация настроек/корней воркспейса с backend embedding-сервисом
 * и инкрементальный reindex по сохранению/изменению файлов.
 */
@injectable()
export class EmbeddingConfigSync implements FrontendApplicationContribution {
    @inject(EmbeddingIndexService) private readonly indexService!: EmbeddingIndexService;
    @inject(PreferenceService) private readonly preferences!: PreferenceService;
    @inject(WorkspaceService) private readonly workspace!: WorkspaceService;
    @inject(FileService) private readonly fileService!: FileService;

    async onStart(): Promise<void> {
        await this.push();
        this.preferences.onPreferenceChanged((e: PreferenceChange) => {
            if (e.preferenceName.startsWith('smart-completions.embedding')) {
                void this.push();
            }
        });
        this.workspace.onWorkspaceChanged(() => void this.push());
        this.fileService.onDidFilesChange(event => this.onFilesChanged(event));
    }

    private async push(): Promise<void> {
        const config = readEmbeddingConfig(this.preferences);
        const roots = this.workspace.tryGetRoots().map(stat => stat.resource.toString());
        try {
            await this.indexService.configure(config, roots);
        } catch {
            /* backend ещё не готов — повтор на следующем изменении */
        }
    }

    private onFilesChanged(event: FileChangesEvent): void {
        if (!this.preferences.get<boolean>('smart-completions.embedding.indexOnSave', true)) {
            return;
        }
        for (const change of event.changes) {
            void this.indexService.reindexFile(change.resource.toString()).catch(() => undefined);
        }
    }
}
