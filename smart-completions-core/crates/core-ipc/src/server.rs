//! Connection serving loop and platform listeners.

use bytes::BytesMut;
use tokio::io::{AsyncRead, AsyncWrite};

use crate::connection::{read_client_frame, write_server_frame, ConnectionError};
use crate::protocol::{ClientFrame, ServerFrame};

/// What a handler decides after processing one client frame.
#[derive(Debug)]
pub enum HandlerOutcome {
    /// Keep serving; send these frames back first.
    Continue(Vec<ServerFrame>),
    /// Stop serving and shut the core down.
    Shutdown,
}

/// Why a connection serving loop ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionEnd {
    /// The peer closed the connection.
    Disconnected,
    /// The peer asked the core to shut down.
    ShutdownRequested,
}

/// Application logic invoked for each client frame.
///
/// Implementors own the document store and dispatcher. The trait is used via
/// static dispatch, so the serving loop never boxes it.
pub trait FrameHandler {
    /// Handles one client frame and returns the next action.
    fn handle(&mut self, frame: ClientFrame) -> HandlerOutcome;
}

/// Serves frames over a single connection until shutdown or disconnect.
///
/// # Errors
/// Returns [`ConnectionError`] on a framing or protocol failure that is not a
/// clean disconnect.
pub async fn serve_connection<R, W, H>(
    mut reader: R,
    mut writer: W,
    handler: &mut H,
) -> Result<ConnectionEnd, ConnectionError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    H: FrameHandler,
{
    let mut scratch = BytesMut::new();

    loop {
        let frame = match read_client_frame(&mut reader, &mut scratch).await {
            Ok(frame) => frame,
            Err(err) if err.is_disconnect() => return Ok(ConnectionEnd::Disconnected),
            Err(err) => return Err(err),
        };

        match handler.handle(frame) {
            HandlerOutcome::Shutdown => return Ok(ConnectionEnd::ShutdownRequested),
            HandlerOutcome::Continue(frames) => {
                write_all_frames(&mut writer, &frames).await?;
            }
        }
    }
}

async fn write_all_frames<W>(writer: &mut W, frames: &[ServerFrame]) -> Result<(), ConnectionError>
where
    W: AsyncWrite + Unpin,
{
    for frame in frames {
        write_server_frame(writer, frame).await?;
    }

    Ok(())
}

/// Binds a Unix domain socket and serves connections until shutdown.
///
/// # Errors
/// Returns an I/O error if binding or accepting fails.
#[cfg(unix)]
pub async fn serve_unix_socket<H>(path: &std::path::Path, handler: &mut H) -> std::io::Result<()>
where
    H: FrameHandler,
{
    remove_stale_socket(path);
    let listener = tokio::net::UnixListener::bind(path)?;
    accept_loop(&listener, handler).await
}

#[cfg(unix)]
async fn accept_loop<H>(listener: &tokio::net::UnixListener, handler: &mut H) -> std::io::Result<()>
where
    H: FrameHandler,
{
    loop {
        let (stream, _addr) = listener.accept().await?;
        let (reader, writer) = stream.into_split();

        match serve_connection(reader, writer, handler).await {
            Ok(ConnectionEnd::ShutdownRequested) => return Ok(()),
            Ok(ConnectionEnd::Disconnected) => {}
            Err(err) => tracing::warn!(error = %err, "core connection ended with error"),
        }
    }
}

#[cfg(unix)]
fn remove_stale_socket(path: &std::path::Path) {
    let _ = std::fs::remove_file(path);
}

/// Binds a Windows named pipe and serves connections until shutdown.
///
/// One server instance is created per accepted client so a fresh instance is
/// always available for the next connection, matching the Win32 pipe model.
///
/// # Errors
/// Returns an I/O error if creating the pipe or accepting fails.
#[cfg(windows)]
pub async fn serve_named_pipe<H>(path: &str, handler: &mut H) -> std::io::Result<()>
where
    H: FrameHandler,
{
    use tokio::net::windows::named_pipe::ServerOptions;

    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(path)?;
    loop {
        server.connect().await?;
        let connected = server;
        server = ServerOptions::new().create(path)?;

        let (reader, writer) = tokio::io::split(connected);
        match serve_connection(reader, writer, handler).await {
            Ok(ConnectionEnd::ShutdownRequested) => return Ok(()),
            Ok(ConnectionEnd::Disconnected) => {}
            Err(err) => tracing::warn!(error = %err, "core connection ended with error"),
        }
    }
}

/// Serves the platform-native local transport: Unix socket or Windows named pipe.
///
/// # Errors
/// Returns an I/O error if binding/creating or accepting fails.
#[cfg(unix)]
pub async fn serve_socket<H>(path: &str, handler: &mut H) -> std::io::Result<()>
where
    H: FrameHandler,
{
    serve_unix_socket(std::path::Path::new(path), handler).await
}

/// Serves the platform-native local transport: Unix socket or Windows named pipe.
///
/// # Errors
/// Returns an I/O error if binding/creating or accepting fails.
#[cfg(windows)]
pub async fn serve_socket<H>(path: &str, handler: &mut H) -> std::io::Result<()>
where
    H: FrameHandler,
{
    serve_named_pipe(path, handler).await
}
