import { injectable } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { EmbeddingIndexClient } from '../../common/protocol';
import { IndexStatus, IndexProgress } from '../../common/embedding-types';

/** Frontend-приёмник событий статуса/прогресса индекса (backend → frontend). */
@injectable()
export class EmbeddingIndexClientImpl implements EmbeddingIndexClient {
    private readonly statusEmitter = new Emitter<IndexStatus>();
    private readonly progressEmitter = new Emitter<IndexProgress>();
    private last: IndexStatus = { state: 'idle', filesIndexed: 0, totalFiles: 0 };

    readonly onStatusDidChange: Event<IndexStatus> = this.statusEmitter.event;
    readonly onProgressDidChange: Event<IndexProgress> = this.progressEmitter.event;

    get lastStatus(): IndexStatus {
        return this.last;
    }

    onStatusChanged(status: IndexStatus): void {
        this.last = status;
        this.statusEmitter.fire(status);
    }

    onIndexProgress(progress: IndexProgress): void {
        this.progressEmitter.fire(progress);
    }
}
