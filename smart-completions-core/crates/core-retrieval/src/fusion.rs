use std::collections::HashMap;

use core_types::Neighbor;

const RRF_K: f32 = 60.0;

/// Fuses per-channel ranked lists into one list via reciprocal rank fusion.
///
/// Items seen in several channels accumulate score and rank above single-source
/// hits. The result is sorted by fused score and truncated to `top_n`.
#[must_use]
pub fn rrf_merge(channels: &[Vec<Neighbor>], top_n: usize) -> Vec<Neighbor> {
    let mut slots = HashMap::<String, RrfSlot>::with_capacity(total_candidate_count(channels));

    for list in channels {
        accumulate_channel(list, &mut slots);
    }

    let mut merged = collect_slots(slots);
    merged.sort_by(compare_neighbors_by_score);
    merged.truncate(top_n);
    merged
}

fn total_candidate_count(channels: &[Vec<Neighbor>]) -> usize {
    channels.iter().map(Vec::len).sum()
}

fn accumulate_channel(list: &[Neighbor], slots: &mut HashMap<String, RrfSlot>) {
    for (rank, neighbor) in list.iter().enumerate() {
        let score = rrf_score(rank);
        let slot = slots
            .entry(neighbor.stable_id().to_owned())
            .or_insert_with(|| RrfSlot::new(neighbor.clone()));
        slot.score += score;
    }
}

fn rrf_score(rank: usize) -> f32 {
    let rank = u16::try_from(rank).unwrap_or(u16::MAX);
    1.0 / (RRF_K + f32::from(rank) + 1.0)
}

fn collect_slots(slots: HashMap<String, RrfSlot>) -> Vec<Neighbor> {
    slots.into_values().map(RrfSlot::into_neighbor).collect()
}

fn compare_neighbors_by_score(left: &Neighbor, right: &Neighbor) -> std::cmp::Ordering {
    right
        .score
        .partial_cmp(&left.score)
        .unwrap_or(std::cmp::Ordering::Equal)
}

/// Accumulator pairing a neighbor with its running fused score.
#[derive(Debug)]
struct RrfSlot {
    neighbor: Neighbor,
    score: f32,
}

impl RrfSlot {
    fn new(neighbor: Neighbor) -> Self {
        Self {
            neighbor,
            score: 0.0,
        }
    }

    fn into_neighbor(mut self) -> Neighbor {
        self.neighbor.score = self.score;
        self.neighbor
    }
}
