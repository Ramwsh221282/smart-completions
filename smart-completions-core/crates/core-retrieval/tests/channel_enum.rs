//! Integration tests for enum-dispatched retrieval channels.

use core_retrieval::{
    ChannelId, ChannelInput, GraphChannel, RetrievalChannelKind, RetrievalConfig, SemanticChannel,
};

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
fn stub_channels_return_no_neighbors_yet() {
    let input = ChannelInput {
        query_text: "query".to_string(),
        vector_text: "query".to_string(),
        file_mode_is_code: true,
    };

    let semantic = RetrievalChannelKind::Semantic(SemanticChannel);

    assert!(semantic.retrieve(&input, 5).is_empty());
}
