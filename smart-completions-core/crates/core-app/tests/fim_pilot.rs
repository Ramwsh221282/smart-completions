//! Integration tests for the FIM pilot route through the core handler.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

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

fn workspace_snapshot(workspace_root: &Path) -> ClientFrame {
    let file = workspace_root.join("src/a.ts");
    ClientFrame::InitialDocumentSnapshot(WireInitialDocument {
        uri: format!("file://{}", file.display()),
        version: 1,
        language_id: "typescript".to_string(),
        file_path: Some("src/a.ts".to_string()),
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

fn workspace_completion(
    workspace_root: &Path,
    model_id: &str,
    mode: CompletionMode,
) -> ClientFrame {
    let file = workspace_root.join("src/a.ts");
    let mut frame = completion(model_id, mode);
    let ClientFrame::CompletionRequest(request) = &mut frame else {
        unreachable!();
    };
    request.uri = format!("file://{}", file.display());
    frame
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
    let workspace_root = temp_workspace_root();
    fs::create_dir_all(workspace_root.join("src")).unwrap();
    fs::write(workspace_root.join("src/a.ts"), "const x = 1;\n").unwrap();
    fs::write(
        workspace_root.join("src/high.ts"),
        "export const high = 1;\nexport const highTwo = 2;\n",
    )
    .unwrap();
    fs::write(workspace_root.join("src/low.ts"), "export const low = 1;\n").unwrap();

    let mut handler = CoreFrameHandler::new(GenerationClient::new(format!(
        "{}/completion",
        server.uri()
    )));
    let (frames, mut receiver) = unbounded_channel::<ServerFrame>();

    drive(&mut handler, workspace_snapshot(&workspace_root), &frames);
    let mut completion =
        workspace_completion(&workspace_root, "qwen2.5-coder", CompletionMode::Fim);
    let ClientFrame::CompletionRequest(request) = &mut completion else {
        unreachable!();
    };
    request.related_file_hints = vec![
        WireRelatedFileHint {
            path: "src/low.ts".to_string(),
            range: None,
            source: "search".to_string(),
            score_hint: 0.1,
        },
        WireRelatedFileHint {
            path: "src/high.ts".to_string(),
            range: Some(Range {
                start_line: 0,
                start_col: 0,
                end_line: 0,
                end_col: 6,
            }),
            source: "definition".to_string(),
            score_hint: 0.9,
        },
        WireRelatedFileHint {
            path: "src/a.ts".to_string(),
            range: None,
            source: "definition".to_string(),
            score_hint: 1.0,
        },
        WireRelatedFileHint {
            path: "src/missing.ts".to_string(),
            range: None,
            source: "search".to_string(),
            score_hint: 0.8,
        },
    ];
    drive(&mut handler, completion, &frames);

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
    let current_uri = format!("file://{}", workspace_root.join("src/a.ts").display());
    let high_index = body.find("<|file_sep|>src/high.ts").unwrap();
    let low_index = body.find("<|file_sep|>src/low.ts").unwrap();

    assert!(high_index < low_index);
    assert!(body.contains("<|file_sep|>src/high.ts"));
    assert!(body.contains("export const high = 1;"));
    assert!(body.contains("<|file_sep|>src/low.ts"));
    assert!(!body.contains("<|file_sep|>src/a.ts\nconst x = 1;"));
    assert!(!body.contains("<|file_sep|>src/missing.ts"));
    assert!(body.contains(&format!("<|file_sep|>diagnostics/{current_uri}")));
    assert!(body.contains("Line 1 [warning] W1: warn"));
    assert!(body.contains(&format!("<|file_sep|>outline/{current_uri}")));
    assert!(body.contains("demo function [1:0-3:0]"));
    assert!(body.contains(&format!("<|file_sep|>signals/{current_uri}")));
    assert!(body.contains("symbol_at_cursor: demo"));
    assert!(body.contains("imported_symbols: dep"));
    assert!(body.contains("declared_types: User"));
    assert!(body.contains("diagnostic_symbols: MissingType"));

    let _ = fs::remove_dir_all(&workspace_root);
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

fn temp_workspace_root() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    std::env::temp_dir().join(format!("sc-core-fim-{}-{nanos}", std::process::id()))
}
