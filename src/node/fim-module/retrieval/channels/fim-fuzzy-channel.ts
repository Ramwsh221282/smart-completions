import { injectable } from '@theia/core/shared/inversify';
import type { Neighbor } from '../../../../common/embedding-types';
import type { FimRetrievalConfig } from '../../../../common/fim-types';
import { SweepFuzzyChannel } from '../../../sweep/retrieval/fuzzy/sweep-fuzzy-channel';
import type { RetrievalChannel, RetrievalChannelInput } from '../fim-retrieval-channel';

@injectable()
export class FimFuzzyRetrievalChannel implements RetrievalChannel {
    readonly id = 'fuzzy';
    readonly codeOnly = true;

    constructor(private readonly fuzzy: SweepFuzzyChannel) {}

    isEnabled(config: FimRetrievalConfig): boolean {
        return config.fuzzy.enabled;
    }

    retrieve(input: RetrievalChannelInput, topN: number): Neighbor[] {
        return this.fuzzy.retrieve(input.fuzzySymbols, topN);
    }
}
