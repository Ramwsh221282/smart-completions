//! Integration tests for SSE generation streaming and cancellation.

use core_llama::{GenerationClient, GenerationRequest};
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn request<'a>() -> GenerationRequest<'a> {
    GenerationRequest {
        prompt: "x",
        max_tokens: 8,
        temperature: 0.0,
        stream: true,
        cache_prompt: true,
        stop: &[],
    }
}

async fn mount_sse(server: &MockServer, body: &'static str) {
    Mock::given(method("POST"))
        .and(path("/completion"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(body),
        )
        .mount(server)
        .await;
}

#[tokio::test]
async fn streams_content_tokens_and_skips_non_json_events() {
    let server = MockServer::start().await;
    mount_sse(
        &server,
        "data: {\"content\":\"he\"}\n\ndata: {\"content\":\"llo\"}\n\ndata: [DONE]\n\n",
    )
    .await;

    let client = GenerationClient::new(format!("{}/completion", server.uri()));
    let cancel = CancellationToken::new();
    let mut tokens = Vec::new();
    client
        .stream_completion(&request(), &cancel, |token| {
            tokens.push(token);
            Ok(())
        })
        .await
        .unwrap();

    assert_eq!(tokens, vec!["he".to_string(), "llo".to_string()]);
}

#[tokio::test]
async fn streams_openai_completions_and_chat_delta_shapes() {
    let server = MockServer::start().await;
    mount_sse(
        &server,
        "data: {\"choices\":[{\"text\":\"foo\"}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"bar\"}}]}\n\ndata: [DONE]\n\n",
    )
    .await;

    let client = GenerationClient::new(format!("{}/completion", server.uri()));
    let cancel = CancellationToken::new();
    let mut tokens = Vec::new();
    client
        .stream_completion(&request(), &cancel, |token| {
            tokens.push(token);
            Ok(())
        })
        .await
        .unwrap();

    assert_eq!(tokens, vec!["foo".to_string(), "bar".to_string()]);
}

#[tokio::test]
async fn a_pre_cancelled_token_yields_no_completion_tokens() {
    let server = MockServer::start().await;
    mount_sse(&server, "data: {\"content\":\"x\"}\n\n").await;

    let client = GenerationClient::new(format!("{}/completion", server.uri()));
    let cancel = CancellationToken::new();
    cancel.cancel();

    let mut tokens = Vec::new();
    client
        .stream_completion(&request(), &cancel, |token| {
            tokens.push(token);
            Ok(())
        })
        .await
        .unwrap();

    assert!(tokens.is_empty());
}
