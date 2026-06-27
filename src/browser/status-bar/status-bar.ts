import { injectable, inject } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, StatusBar, StatusBarAlignment } from '@theia/core/lib/browser';
import { EmbeddingIndexClientImpl } from '../embedding/index-client';
import { IndexStatus } from '../../common/embedding-types';

const ITEM_ID = 'smart-completions-index';

/**
 * Статус-бар показывает состояние индекса без открытия отдельной view, чтобы long-running
 * reconcile/rebuild был заметен прямо во время редактирования и не казался "тихим зависанием".
 */
@injectable()
export class SmartCompletionsStatusBar implements FrontendApplicationContribution {
    @inject(StatusBar) private readonly statusBar!: StatusBar;
    @inject(EmbeddingIndexClientImpl) private readonly client!: EmbeddingIndexClientImpl;

    onStart(): void {
        this.render(this.client.lastStatus);
        this.client.onStatusDidChange(status => this.render(status));
    }

    private render(status: IndexStatus): void {
        void this.statusBar.setElement(ITEM_ID, {
            text: this.format(status),
            alignment: StatusBarAlignment.RIGHT,
            priority: 0,
            tooltip: status.error ? `Smart Completions index error: ${status.error}` : 'Smart Completions index',
        });
    }

    private format(status: IndexStatus): string {
        switch (status.state) {
            case 'indexing':
                return `$(sync~spin) SC index ${status.filesIndexed}/${status.totalFiles}`;
            case 'ready':
                return '$(database) SC index ready';
            case 'error':
                return '$(error) SC index error';
            default:
                return '$(database) SC index idle';
        }
    }
}
