//! Connection serving: a read loop plus a writer task draining the frame channel.

use bytes::BytesMut;
use core_ipc::{read_client_frame, write_server_frame, ServerFrame};
use core_llama::GenerationClient;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use crate::handler::{CoreFrameHandler, HandleOutcome};

/// Runs the core server on `socket_path` until a shutdown frame arrives.
///
/// # Errors
/// Returns an I/O error if binding or accepting fails, or if the platform has
/// no socket transport yet.
pub async fn run(socket_path: &str, generation: GenerationClient) -> std::io::Result<()> {
    let mut handler = CoreFrameHandler::new(generation);
    serve(socket_path, &mut handler).await
}

#[cfg(unix)]
async fn serve(socket_path: &str, handler: &mut CoreFrameHandler) -> std::io::Result<()> {
    let path = std::path::Path::new(socket_path);
    let _ = std::fs::remove_file(path);
    let listener = tokio::net::UnixListener::bind(path)?;

    loop {
        let (stream, _addr) = listener.accept().await?;
        let (reader, writer) = stream.into_split();
        if serve_connection(reader, writer, handler).await {
            return Ok(());
        }
    }
}

#[cfg(not(unix))]
async fn serve(_socket_path: &str, _handler: &mut CoreFrameHandler) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "named-pipe transport is added on the cross-platform phase",
    ))
}

#[cfg(unix)]
async fn serve_connection(
    reader: tokio::net::unix::OwnedReadHalf,
    writer: tokio::net::unix::OwnedWriteHalf,
    handler: &mut CoreFrameHandler,
) -> bool {
    let (frames, receiver) = unbounded_channel::<ServerFrame>();
    let writer_task = tokio::spawn(drain_frames(receiver, writer));

    let shutdown = read_loop(reader, handler, &frames).await;

    drop(frames);
    let _ = writer_task.await;
    shutdown
}

#[cfg(unix)]
async fn read_loop(
    mut reader: tokio::net::unix::OwnedReadHalf,
    handler: &mut CoreFrameHandler,
    frames: &UnboundedSender<ServerFrame>,
) -> bool {
    let mut scratch = BytesMut::new();

    loop {
        match read_client_frame(&mut reader, &mut scratch).await {
            Ok(frame) => {
                if matches!(handler.handle(frame, frames), HandleOutcome::Shutdown) {
                    return true;
                }
            }
            Err(err) if err.is_disconnect() => return false,
            Err(err) => {
                tracing::warn!(error = %err, "core connection ended with error");
                return false;
            }
        }
    }
}

#[cfg(unix)]
async fn drain_frames(
    mut receiver: UnboundedReceiver<ServerFrame>,
    mut writer: tokio::net::unix::OwnedWriteHalf,
) {
    while let Some(frame) = receiver.recv().await {
        if write_server_frame(&mut writer, &frame).await.is_err() {
            break;
        }
    }
}
