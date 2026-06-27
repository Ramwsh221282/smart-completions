//! Windows named-pipe transport round-trip. Compiled only on Windows.

#![cfg(windows)]

use bytes::BytesMut;
use core_ipc::{
    read_server_frame, serve_socket, write_client_frame, ClientFrame, FrameHandler, HandlerOutcome,
    ServerFrame, WireCompletionRequest, WireShutdown,
};
use core_types::{CompletionMode, FileMode, Position, Range};
use tokio::net::windows::named_pipe::ClientOptions;

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
        recent_edit_uris: Vec::new(),
        recent_edits: Vec::new(),
        original_window_text: None,
        diagnostics: Vec::new(),
        outline: Vec::new(),
        related_file_hints: Vec::new(),
        signals: None,
        config_version: 1,
        config_json: None,
    }))
}

fn shutdown() -> ClientFrame {
    ClientFrame::Shutdown(WireShutdown {
        reason: "test".to_string(),
    })
}

fn unique_pipe_path() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!(r"\\.\pipe\sc-core-{}-{nanos}", std::process::id())
}

#[tokio::test]
async fn named_pipe_serves_a_completion_round_trip() {
    let path = unique_pipe_path();
    let server_path = path.clone();

    let server_task = tokio::spawn(async move {
        let mut handler = DoneHandler;
        serve_socket(&server_path, &mut handler).await
    });

    // Retry connect until the server has created the first pipe instance.
    let client = loop {
        match ClientOptions::new().open(&path) {
            Ok(client) => break client,
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(10)).await,
        }
    };
    let (mut reader, mut writer) = tokio::io::split(client);

    write_client_frame(&mut writer, &completion(3))
        .await
        .unwrap();

    let mut scratch = BytesMut::new();
    let response = read_server_frame(&mut reader, &mut scratch).await.unwrap();
    assert_eq!(response, ServerFrame::Done { request_id: 3 });

    write_client_frame(&mut writer, &shutdown()).await.unwrap();

    server_task.await.unwrap().unwrap();
}
