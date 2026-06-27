//! Integration tests for reciprocal rank fusion.

use core_retrieval::rrf_merge;
use core_types::{Neighbor, Range};

fn neighbor(id: &str) -> Neighbor {
    Neighbor {
        id: id.to_string(),
        file_path: format!("{id}.ts"),
        range: Range {
            start_line: 0,
            start_col: 0,
            end_line: 1,
            end_col: 0,
        },
        text: id.to_string(),
        score: 0.0,
    }
}

#[test]
fn rrf_deduplicates_and_prefers_items_seen_in_multiple_channels() {
    let a = neighbor("a");
    let b = neighbor("b");
    let c = neighbor("c");

    let merged = rrf_merge(&[vec![a.clone(), b], vec![c, a]], 2);

    assert_eq!(merged.len(), 2);
    assert_eq!(merged[0].id, "a");
}

#[test]
fn rrf_truncates_to_top_n() {
    let merged = rrf_merge(&[vec![neighbor("a"), neighbor("b"), neighbor("c")]], 2);

    assert_eq!(merged.len(), 2);
}
