//! Integration tests for the wire protocol and connection serving loop.

use bytes::BytesMut;
use core_ipc::{
    decode_client_frame, decode_server_frame, encode_client_frame, encode_server_frame,
    read_client_frame, read_server_frame, serve_connection, write_client_frame, ClientFrame,
    ConnectionEnd, FrameHandler, HandlerOutcome, ServerFrame, WireCompletionRequest,
    WireDiagnostic, WireDiagnosticSeverity, WireDocumentKind, WireInitialDocument, WireOutlineItem,
    WireRecentEdit, WireRelatedFileHint, WireShutdown, WireSignals,
};
use core_types::{CompletionMode, FileMode, Position, Range};

struct DoneHandler;

impl FrameHandler for DoneHandler {
    fn handle(&mut self, frame: ClientFrame) -> HandlerOutcome {
        match frame {
            ClientFrame::Shutdown(_) => HandlerOutcome::Shutdown,
            ClientFrame::CompletionRequest(request) => {
                HandlerOutcome::Continue(vec![ServerFrame::Done {
                    request_id: request.request_id,
                }])
            }
            _ => HandlerOutcome::Continue(Vec::new()),
        }
    }
}

fn completion(request_id: u64) -> ClientFrame {
    ClientFrame::CompletionRequest(Box::new(WireCompletionRequest {
        request_id,
        mode: CompletionMode::Fim,
        model_id: "qwen2.5-coder".to_string(),
        uri: "file:///a.ts".to_string(),
        version: 1,
        language_id: "typescript".to_string(),
        file_mode: FileMode::Code,
        cursor: Position {
            line: 0,
            column: 0,
            offset: 0,
        },
        editable_region: Some(Range {
            start_line: 0,
            start_col: 0,
            end_line: 0,
            end_col: 5,
        }),
        recent_edit_uris: vec!["file:///a.ts".to_string(), "file:///b.ts".to_string()],
        recent_edits: vec![WireRecentEdit {
            uri: "file:///a.ts".to_string(),
            unified_diff: "--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-old\n+new".to_string(),
            timestamp: 1,
        }],
        original_window_text: Some("old".to_string()),
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
        config_json: Some("{\"fim\":true}".to_string()),
    }))
}

fn shutdown() -> ClientFrame {
    ClientFrame::Shutdown(WireShutdown {
        reason: "test".to_string(),
    })
}

#[test]
fn open_buffer_snapshot_round_trips_through_flatbuffers() {
    let frame = ClientFrame::OpenBufferSnapshot(WireInitialDocument {
        uri: "untitled:1".to_string(),
        version: 2,
        language_id: "markdown".to_string(),
        file_path: None,
        file_mode: FileMode::Prose,
        kind: WireDocumentKind::Untitled,
        text: "hello".to_string(),
    });

    let encoded = encode_client_frame(&frame);
    let decoded = decode_client_frame(&encoded).unwrap();

    assert_eq!(decoded, frame);
}

#[test]
fn error_frame_round_trips_through_flatbuffers() {
    let frame = ServerFrame::Error {
        request_id: 9,
        message: "boom".to_string(),
    };

    let encoded = encode_server_frame(&frame);
    let decoded = decode_server_frame(&encoded).unwrap();

    assert_eq!(decoded, frame);
}

#[test]
fn edit_frame_round_trips_through_flatbuffers() {
    let frame = ServerFrame::Edit {
        request_id: 3,
        range: Range {
            start_line: 0,
            start_col: 0,
            end_line: 1,
            end_col: 0,
        },
        new_text: "const x = 2;".to_string(),
        jump: Some(Position {
            line: 4,
            column: 2,
            offset: 0,
        }),
    };

    let encoded = encode_server_frame(&frame);
    let decoded = decode_server_frame(&encoded).unwrap();

    assert_eq!(decoded, frame);
}

#[tokio::test]
async fn client_frame_round_trips_through_framing() {
    let (a, b) = tokio::io::duplex(1024);
    let (_a_read, mut a_write) = tokio::io::split(a);
    let (mut b_read, _b_write) = tokio::io::split(b);

    let frame = completion(11);
    write_client_frame(&mut a_write, &frame).await.unwrap();

    let mut scratch = BytesMut::new();
    let received = read_client_frame(&mut b_read, &mut scratch).await.unwrap();

    assert_eq!(received, frame);
}

#[tokio::test]
async fn serve_connection_answers_completion_and_stops_on_shutdown() {
    let (client, server) = tokio::io::duplex(4096);
    let (mut client_read, mut client_write) = tokio::io::split(client);
    let (server_read, server_write) = tokio::io::split(server);

    let server_task = tokio::spawn(async move {
        let mut handler = DoneHandler;
        serve_connection(server_read, server_write, &mut handler).await
    });

    write_client_frame(&mut client_write, &completion(7))
        .await
        .unwrap();

    let mut scratch = BytesMut::new();
    let response = read_server_frame(&mut client_read, &mut scratch)
        .await
        .unwrap();
    assert_eq!(response, ServerFrame::Done { request_id: 7 });

    write_client_frame(&mut client_write, &shutdown())
        .await
        .unwrap();

    let end = server_task.await.unwrap().unwrap();
    assert_eq!(end, ConnectionEnd::ShutdownRequested);
}

#[cfg(unix)]
#[tokio::test]
async fn unix_socket_serves_a_completion_round_trip() {
    use core_ipc::serve_unix_socket;

    let path = unique_socket_path();
    let server_path = path.clone();

    let server_task = tokio::spawn(async move {
        let mut handler = DoneHandler;
        serve_unix_socket(&server_path, &mut handler).await
    });

    wait_for_path(&path).await;

    let stream = tokio::net::UnixStream::connect(&path).await.unwrap();
    let (mut reader, mut writer) = stream.into_split();

    write_client_frame(&mut writer, &completion(3))
        .await
        .unwrap();

    let mut scratch = BytesMut::new();
    let response = read_server_frame(&mut reader, &mut scratch).await.unwrap();
    assert_eq!(response, ServerFrame::Done { request_id: 3 });

    write_client_frame(&mut writer, &shutdown()).await.unwrap();

    server_task.await.unwrap().unwrap();
    let _ = std::fs::remove_file(&path);
}

#[cfg(unix)]
fn unique_socket_path() -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());

    std::env::temp_dir().join(format!("sc-core-{}-{nanos}.sock", std::process::id()))
}

#[cfg(unix)]
async fn wait_for_path(path: &std::path::Path) {
    for _ in 0..100 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}
