//! Integration tests for the FIM pilot route through the core handler.

use std::time::Duration;

use core_app::CoreFrameHandler;
use core_ipc::{
    ClientFrame, ServerFrame, WireCompletionRequest, WireDiagnostic, WireDiagnosticSeverity,
    WireDocumentKind, WireInitialDocument, WireOutlineItem, WireRelatedFileHint, WireSignals,
};
use core_llama::GenerationClient;
use core_types::{CompletionMode, FileMode, Position, Range};
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
        editable_region: Some(Range {
            start_line: 0,
            start_col: 0,
            end_line: 0,
            end_col: 10,
        }),
        recent_edit_uris: vec!["file:///a.ts".to_string(), "file:///b.ts".to_string()],
        diagnostics: vec![WireDiagnostic {
            range: Range {
                start_line: 0,
                start_col: 0,
                end_line: 0,
                end_col: 1,
            },
            severity: WireDiagnosticSeverity::Warning,
            message: "warn".to_string(),
            code: Some("W1".to_string()),
        }],
        outline: vec![WireOutlineItem {
            name: "demo".to_string(),
            kind: "function".to_string(),
            range: Range {
                start_line: 0,
                start_col: 0,
                end_line: 2,
                end_col: 0,
            },
            selection_range: Range {
                start_line: 0,
                start_col: 9,
                end_line: 0,
                end_col: 13,
            },
        }],
        related_file_hints: vec![WireRelatedFileHint {
            path: "src/dep.ts".to_string(),
            range: None,
            source: "search".to_string(),
            score_hint: 0.5,
        }],
        signals: Some(WireSignals {
            symbol_at_cursor: Some("demo".to_string()),
            renamed_symbols: vec!["before".to_string(), "after".to_string()],
            imported_symbols: vec!["dep".to_string()],
            declared_types: vec!["User".to_string()],
            test_names: vec!["works".to_string()],
            diagnostic_symbols: vec!["MissingType".to_string()],
            fuzzy_symbols: vec!["demoHelper".to_string()],
            retrieval_signal_hints: vec!["cursor tail".to_string()],
        }),
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
async fn includes_frontend_metadata_blocks_in_the_fim_prompt() {
    let server = MockServer::start().await;
    mount_completion(&server, "data: {\"content\":\"ok\"}\n\ndata: [DONE]\n\n").await;

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
            text: "ok".to_string(),
        }
    );
    assert_eq!(
        next_frame(&mut receiver).await,
        ServerFrame::Done { request_id: 1 }
    );

    let requests = server.received_requests().await.unwrap();
    let body = String::from_utf8(requests[0].body.clone()).unwrap();

    assert!(body.contains("<|file_sep|>related/file:///a.ts"));
    assert!(body.contains("src/dep.ts source=search score=0.50"));
    assert!(body.contains("<|file_sep|>diagnostics/file:///a.ts"));
    assert!(body.contains("Line 1 [warning] W1: warn"));
    assert!(body.contains("<|file_sep|>outline/file:///a.ts"));
    assert!(body.contains("demo function [1:0-3:0]"));
    assert!(body.contains("<|file_sep|>signals/file:///a.ts"));
    assert!(body.contains("symbol_at_cursor: demo"));
    assert!(body.contains("imported_symbols: dep"));
    assert!(body.contains("declared_types: User"));
    assert!(body.contains("diagnostic_symbols: MissingType"));
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
