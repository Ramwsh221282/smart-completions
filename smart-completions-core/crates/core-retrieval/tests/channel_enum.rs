//! Integration tests for enum-dispatched retrieval channels.

use core_retrieval::{
    ChannelId, ChannelInput, GraphChannel, RetrievalChannelKind, RetrievalConfig,
    RetrievalDocument, SemanticChannel,
};
use core_types::Range;

fn document(path: &str, text: &str, source_hint: &str, score_hint: f32) -> RetrievalDocument {
    RetrievalDocument {
        id: path.to_string(),
        file_path: path.to_string(),
        range: Range {
            start_line: 0,
            start_col: 0,
            end_line: 1,
            end_col: 0,
        },
        text: text.to_string(),
        source_hint: source_hint.to_string(),
        score_hint,
    }
}

fn input() -> ChannelInput {
    ChannelInput {
        query_text: "demo helper".to_string(),
        vector_text: "demo helper".to_string(),
        file_mode_is_code: true,
        current_file_path: "src/current.ts".to_string(),
        documents: vec![
            document(
                "src/helper.ts",
                "export const demoHelper = 1;",
                "definition",
                0.5,
            ),
            document("src/other.ts", "export const nothing = 1;", "search", 0.0),
        ],
        signal_terms: vec!["demo".to_string(), "helper".to_string()],
    }
}

#[test]
fn enum_dispatch_reports_each_channel_id() {
    let semantic = RetrievalChannelKind::Semantic(SemanticChannel);
    let graph = RetrievalChannelKind::Graph(GraphChannel);

    assert_eq!(semantic.id(), ChannelId::Semantic);
    assert_eq!(graph.id(), ChannelId::Graph);
}

#[test]
fn config_toggles_enable_matching_channels() {
    let config = RetrievalConfig {
        semantic_enabled: true,
        graph_enabled: false,
        fuzzy_enabled: true,
    };

    let semantic = RetrievalChannelKind::Semantic(SemanticChannel);
    let graph = RetrievalChannelKind::Graph(GraphChannel);

    assert!(semantic.is_enabled(config));
    assert!(!graph.is_enabled(config));
}

#[test]
fn semantic_channel_returns_ranked_neighbors() {
    let semantic = RetrievalChannelKind::Semantic(SemanticChannel);
    let results = semantic.retrieve(&input(), 5);

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].file_path, "src/helper.ts");
    assert!(results[0].score > 0.0);
}
