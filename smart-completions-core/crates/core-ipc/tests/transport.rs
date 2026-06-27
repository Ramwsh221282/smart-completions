//! Integration tests for the wire protocol and connection serving loop.

use bytes::BytesMut;
use core_ipc::{
    read_client_frame, read_server_frame, serve_connection, write_client_frame, ClientFrame,
    ConnectionEnd, FrameHandler, HandlerOutcome, ServerFrame, WireCompletionRequest, WireShutdown,
};
use core_types::{CompletionMode, FileMode, Position};

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
    ClientFrame::CompletionRequest(WireCompletionRequest {
        request_id,
        mode: CompletionMode::Fim,
        model_id: "qwen2.5-coder".to_string(),
        uri: "file:///a.ts".to_string(),
        version: 1,
        file_mode: FileMode::Code,
        cursor: Position {
            line: 0,
            column: 0,
            offset: 0,
        },
        config_version: 1,
    })
}

fn shutdown() -> ClientFrame {
    ClientFrame::Shutdown(WireShutdown {
        reason: "test".to_string(),
    })
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
