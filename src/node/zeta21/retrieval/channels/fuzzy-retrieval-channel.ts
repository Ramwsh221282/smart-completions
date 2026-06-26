import { injectable } from '@theia/core/shared/inversify';
import type { Neighbor } from '../../../../common/embedding-types';
import { SweepFuzzyChannel } from '../../../sweep/retrieval/fuzzy/sweep-fuzzy-channel';
import type { RetrievalChannel, RetrievalChannelInput } from '../retrieval-channel';
import type { ZetaRetrievalConfig } from '../zeta-retrieval-orchestrator';

/** Нечёткий канал zeta21 оборачивает общий SweepFuzzyChannel без отдельного дублирования индекса. */
@injectable()
export class ZetaFuzzyRetrievalChannel implements RetrievalChannel {
    readonly id = 'fuzzy';
    readonly codeOnly = true;

    constructor(private readonly fuzzy: SweepFuzzyChannel) {}

    isEnabled(config: ZetaRetrievalConfig): boolean {
        return config.fuzzy.enabled;
    }

    retrieve(input: RetrievalChannelInput, topN: number): Neighbor[] {
        return this.fuzzy.retrieve(input.fuzzySymbols, topN);
    }
}
