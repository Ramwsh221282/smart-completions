//! Integration tests for the batch embedding client.

use core_llama::EmbeddingClient;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn embeds_a_batch_and_orders_vectors_by_index() {
    let server = MockServer::start().await;
    let body = serde_json::json!({
        "data": [
            { "index": 1, "embedding": [0.2] },
            { "index": 0, "embedding": [0.1] }
        ]
    });
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(&server)
        .await;

    let client = EmbeddingClient::new(format!("{}/v1/embeddings", server.uri()));
    let vectors = client.embed_batch(&["a", "b"], "model").await.unwrap();

    assert_eq!(vectors, vec![vec![0.1_f32], vec![0.2_f32]]);
}

#[tokio::test]
async fn surfaces_http_errors() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;

    let client = EmbeddingClient::new(format!("{}/v1/embeddings", server.uri()));
    let result = client.embed_batch(&["a"], "model").await;

    assert!(result.is_err());
}
