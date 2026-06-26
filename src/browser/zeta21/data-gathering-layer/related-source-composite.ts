import type { RelatedCandidate } from '../../../common/zeta21/related-files';
import type { RelatedSource, RelatedSourceContext } from './sources/related-source';

/** Последовательно обходит zeta21 related-источники, сохраняя tie-break порядок и изолируя сбои каждого из них. */
export async function collectRelatedCandidates(
    sources: RelatedSource[],
    ctx: RelatedSourceContext,
    onError?: (id: string, error: unknown) => void,
    onCollected?: (id: string, count: number) => void,
): Promise<RelatedCandidate[]> {
    const out: RelatedCandidate[] = [];
    for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        try {
            const produced = await source.collect(ctx);
            onCollected?.(source.id, produced.length);
            pushAll(out, produced);
        } catch (error) {
            onError?.(source.id, error);
        }
    }
    return out;
}

function pushAll<T>(target: T[], source: T[]): void {
    for (let i = 0; i < source.length; i++) {
        target.push(source[i]);
    }
}
