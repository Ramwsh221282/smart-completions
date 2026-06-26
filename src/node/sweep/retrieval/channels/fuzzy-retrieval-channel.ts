import { injectable } from '@theia/core/shared/inversify';
import type { Neighbor } from '../../../../common/embedding-types';
import type { SweepRetrievalConfig } from '../sweep-retrieval-orchestrator';
import { SweepFuzzyChannel } from '../fuzzy/sweep-fuzzy-channel';
import type { RetrievalChannel, RetrievalChannelInput } from '../retrieval-channel';

/** Нечёткий канал оборачивает существующий SweepFuzzyChannel без изменения его API. */
@injectable()
export class FuzzyRetrievalChannel implements RetrievalChannel {
    readonly id = 'fuzzy';
    readonly codeOnly = true;

    constructor(private readonly fuzzy: SweepFuzzyChannel) {}

    isEnabled(config: SweepRetrievalConfig): boolean {
        return config.fuzzy.enabled;
    }

    retrieve(input: RetrievalChannelInput, topN: number): Neighbor[] {
        return this.fuzzy.retrieve(input.fuzzySymbols, topN);
    }
}
