//! Integration tests for the rerank client and its fail-open signal.

use core_llama::{looks_broken, RerankClient, RerankItem};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn reranks_documents_and_returns_scored_indices() {
    let server = MockServer::start().await;
    let body = serde_json::json!({
        "results": [
            { "index": 0, "relevance_score": 0.9 },
            { "index": 1, "relevance_score": 0.1 }
        ]
    });
    Mock::given(method("POST"))
        .and(path("/v1/rerank"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(&server)
        .await;

    let client = RerankClient::new(format!("{}/v1/rerank", server.uri()));
    let results = client.rerank("q", &["a", "b"], 2).await.unwrap();

    assert_eq!(results.len(), 2);
    assert_eq!(results[0].index, 0);
}

#[test]
fn looks_broken_flags_empty_and_all_zero_scores() {
    assert!(looks_broken(&[]));
    assert!(looks_broken(&[item(0, 0.0), item(1, 0.0)]));
    assert!(!looks_broken(&[item(0, 0.0), item(1, 0.7)]));
}

fn item(index: usize, relevance_score: f32) -> RerankItem {
    RerankItem {
        index,
        relevance_score,
    }
}
