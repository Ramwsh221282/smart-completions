//! Connection serving: a read loop plus a writer task draining the frame channel.
//!
//! The listener is platform-native (Unix-domain socket or Windows named pipe),
//! but the per-connection serving logic is generic over any async byte stream.

use bytes::BytesMut;
use core_ipc::{read_client_frame, write_server_frame, ServerFrame};
use core_llama::GenerationClient;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use crate::handler::{CoreFrameHandler, HandleOutcome};

/// Runs the core server on `socket_path` until a shutdown frame arrives.
///
/// FIM and NES generation target separate llama-server endpoints.
///
/// # Errors
/// Returns an I/O error if binding or accepting fails, or if the platform has
/// no socket transport yet.
pub async fn run(
    socket_path: &str,
    fim_generation: GenerationClient,
    nes_generation: GenerationClient,
) -> std::io::Result<()> {
    let mut handler = CoreFrameHandler::new(fim_generation, nes_generation);
    serve(socket_path, &mut handler).await
}

#[cfg(unix)]
async fn serve(socket_path: &str, handler: &mut CoreFrameHandler) -> std::io::Result<()> {
    let path = std::path::Path::new(socket_path);
    let _ = std::fs::remove_file(path);
    let listener = tokio::net::UnixListener::bind(path)?;

    loop {
        let (stream, _addr) = listener.accept().await?;
        let (reader, writer) = tokio::io::split(stream);
        if serve_connection(reader, writer, handler).await {
            return Ok(());
        }
    }
}

#[cfg(windows)]
async fn serve(socket_path: &str, handler: &mut CoreFrameHandler) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;

    // A fresh server instance is created before serving the connected one so the
    // next client always has a pipe instance to connect to.
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(socket_path)?;

    loop {
        server.connect().await?;
        let connected = server;
        server = ServerOptions::new().create(socket_path)?;

        let (reader, writer) = tokio::io::split(connected);
        if serve_connection(reader, writer, handler).await {
            return Ok(());
        }
    }
}

#[cfg(not(any(unix, windows)))]
async fn serve(_socket_path: &str, _handler: &mut CoreFrameHandler) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "no local socket transport on this platform",
    ))
}

// Returns true when the peer asked the core to shut down. Generic over the
// stream type so the unix-socket and named-pipe halves share one serving loop.
async fn serve_connection<R, W>(reader: R, writer: W, handler: &mut CoreFrameHandler) -> bool
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (frames, receiver) = unbounded_channel::<ServerFrame>();
    let writer_task = tokio::spawn(drain_frames(receiver, writer));

    let shutdown = read_loop(reader, handler, &frames).await;

    drop(frames);
    let _ = writer_task.await;
    shutdown
}

async fn read_loop<R>(
    mut reader: R,
    handler: &mut CoreFrameHandler,
    frames: &UnboundedSender<ServerFrame>,
) -> bool
where
    R: AsyncRead + Unpin,
{
    let mut scratch = BytesMut::new();

    loop {
        match read_client_frame(&mut reader, &mut scratch).await {
            Ok(frame) => {
                if matches!(handler.handle(frame, frames).await, HandleOutcome::Shutdown) {
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

async fn drain_frames<W>(mut receiver: UnboundedReceiver<ServerFrame>, mut writer: W)
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    while let Some(frame) = receiver.recv().await {
        if write_server_frame(&mut writer, &frame).await.is_err() {
            break;
        }
    }
}
