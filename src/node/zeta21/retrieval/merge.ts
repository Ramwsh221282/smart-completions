import type { Neighbor } from '../../../common/embedding-types';

// RRF constant совпадает со Sweep и hybrid retriever, чтобы score scale оставался совместимым с rerank gate.
const RRF_K = 60;

interface AccumulatedNeighbor {
    neighbor: Neighbor;
    score: number;
}

/** Сливает zeta21 retrieval channels через Reciprocal Rank Fusion с дедупом по filePath:start:end. */
export function mergeNeighborChannels(channels: Neighbor[][], topN: number): Neighbor[] {
    if (topN <= 0) {
        return [];
    }
    const acc = new Map<string, AccumulatedNeighbor>();
    for (let i = 0; i < channels.length; i++) {
        const list = channels[i];
        for (let rank = 0; rank < list.length; rank++) {
            const neighbor = list[rank];
            const key = `${neighbor.filePath}:${neighbor.startLine}:${neighbor.endLine}`;
            const add = 1 / (RRF_K + rank + 1);
            const current = acc.get(key);
            if (current) {
                current.score += add;
            } else {
                acc.set(key, { neighbor, score: add });
            }
        }
    }
    const merged = Array.from(acc.values());
    merged.sort((a, b) => b.score - a.score);
    const limit = Math.min(topN, merged.length);
    const out = new Array<Neighbor>(limit);
    for (let i = 0; i < limit; i++) {
        const item = merged[i];
        out[i] = { ...item.neighbor, score: item.score };
    }
    return out;
}
