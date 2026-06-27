//! Integration tests for the FIM pilot route through the core handler.

use std::time::Duration;

use core_app::CoreFrameHandler;
use core_ipc::{
    ClientFrame, ServerFrame, WireCompletionRequest, WireDocumentKind, WireInitialDocument,
};
use core_llama::GenerationClient;
use core_types::{CompletionMode, FileMode, Position};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn mount_completion(server: &MockServer, body: &'static str) {
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

fn snapshot() -> ClientFrame {
    ClientFrame::InitialDocumentSnapshot(WireInitialDocument {
        uri: "file:///a.ts".to_string(),
        version: 1,
        language_id: "typescript".to_string(),
        file_path: Some("a.ts".to_string()),
        file_mode: FileMode::Code,
        kind: WireDocumentKind::File,
        text: "const x = 1;\n".to_string(),
    })
}

fn completion(model_id: &str, mode: CompletionMode) -> ClientFrame {
    ClientFrame::CompletionRequest(Box::new(WireCompletionRequest {
        request_id: 1,
        mode,
        model_id: model_id.to_string(),
        uri: "file:///a.ts".to_string(),
        version: 1,
        language_id: "typescript".to_string(),
        file_mode: FileMode::Code,
        cursor: Position {
            line: 0,
            column: 10,
            offset: 0,
        },
        editable_region: None,
        recent_edit_uris: Vec::new(),
        diagnostics: Vec::new(),
        outline: Vec::new(),
        related_file_hints: Vec::new(),
        signals: None,
        config_version: 1,
        config_json: None,
    }))
}

async fn next_frame(receiver: &mut UnboundedReceiver<ServerFrame>) -> ServerFrame {
    tokio::time::timeout(Duration::from_secs(5), receiver.recv())
        .await
        .expect("frame did not arrive in time")
        .expect("channel closed before a frame arrived")
}

fn drive(
    handler: &mut CoreFrameHandler,
    frame: ClientFrame,
    frames: &UnboundedSender<ServerFrame>,
) {
    let _ = handler.handle(frame, frames);
}

#[tokio::test]
async fn routes_a_fim_completion_and_streams_tokens_then_done() {
    let server = MockServer::start().await;
    mount_completion(&server, "data: {\"content\":\"foo\"}\n\ndata: [DONE]\n\n").await;

    let mut handler = CoreFrameHandler::new(GenerationClient::new(format!(
        "{}/completion",
        server.uri()
    )));
    let (frames, mut receiver) = unbounded_channel::<ServerFrame>();

    drive(&mut handler, snapshot(), &frames);
    drive(
        &mut handler,
        completion("qwen2.5-coder", CompletionMode::Fim),
        &frames,
    );

    assert_eq!(
        next_frame(&mut receiver).await,
        ServerFrame::Token {
            request_id: 1,
            text: "foo".to_string(),
        }
    );
    assert_eq!(
        next_frame(&mut receiver).await,
        ServerFrame::Done { request_id: 1 }
    );
}

#[tokio::test]
async fn rejects_an_unsupported_fim_model_with_an_error_frame() {
    let mut handler = CoreFrameHandler::new(GenerationClient::new("http://127.0.0.1:1/completion"));
    let (frames, mut receiver) = unbounded_channel::<ServerFrame>();

    drive(&mut handler, snapshot(), &frames);
    drive(
        &mut handler,
        completion("ghost-model", CompletionMode::Fim),
        &frames,
    );

    let frame = next_frame(&mut receiver).await;
    assert!(matches!(frame, ServerFrame::Error { request_id: 1, .. }));
}

#[tokio::test]
async fn rejects_nes_requests_in_the_fim_pilot() {
    let mut handler = CoreFrameHandler::new(GenerationClient::new("http://127.0.0.1:1/completion"));
    let (frames, mut receiver) = unbounded_channel::<ServerFrame>();

    drive(&mut handler, snapshot(), &frames);
    drive(
        &mut handler,
        completion("sweep-default", CompletionMode::Nes),
        &frames,
    );

    let frame = next_frame(&mut receiver).await;
    assert!(matches!(frame, ServerFrame::Error { request_id: 1, .. }));
}
