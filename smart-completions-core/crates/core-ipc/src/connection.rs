//! Frame exchange combining length-prefixed framing with the wire protocol.

use bytes::BytesMut;
use tokio::io::{AsyncRead, AsyncWrite};

use crate::framing::{read_frame, write_frame, FrameError};
use crate::protocol::{
    decode_client_frame, decode_server_frame, encode_client_frame, encode_server_frame,
    ClientFrame, ProtocolError, ServerFrame,
};

/// Errors while exchanging frames over a connection.
#[derive(Debug, thiserror::Error)]
pub enum ConnectionError {
    /// Length-prefix framing failure.
    #[error("framing error: {0}")]
    Frame(#[from] FrameError),

    /// Payload encode or decode failure.
    #[error("protocol error: {0}")]
    Protocol(#[from] ProtocolError),
}

impl ConnectionError {
    /// Returns whether the error is a clean peer disconnect.
    #[must_use]
    pub fn is_disconnect(&self) -> bool {
        matches!(
            self,
            Self::Frame(FrameError::Io(err)) if err.kind() == std::io::ErrorKind::UnexpectedEof
        )
    }
}

/// Reads one client frame.
///
/// # Errors
/// Returns [`ConnectionError`] on framing or decode failure.
pub async fn read_client_frame<R>(
    reader: &mut R,
    scratch: &mut BytesMut,
) -> Result<ClientFrame, ConnectionError>
where
    R: AsyncRead + Unpin,
{
    let payload = read_frame(reader, scratch).await?;
    Ok(decode_client_frame(&payload)?)
}

/// Writes one client frame.
///
/// # Errors
/// Returns [`ConnectionError`] on encode or framing failure.
pub async fn write_client_frame<W>(
    writer: &mut W,
    frame: &ClientFrame,
) -> Result<(), ConnectionError>
where
    W: AsyncWrite + Unpin,
{
    let payload = encode_client_frame(frame);
    write_frame(writer, &payload).await?;
    Ok(())
}

/// Reads one server frame.
///
/// # Errors
/// Returns [`ConnectionError`] on framing or decode failure.
pub async fn read_server_frame<R>(
    reader: &mut R,
    scratch: &mut BytesMut,
) -> Result<ServerFrame, ConnectionError>
where
    R: AsyncRead + Unpin,
{
    let payload = read_frame(reader, scratch).await?;
    Ok(decode_server_frame(&payload)?)
}

/// Writes one server frame.
///
/// # Errors
/// Returns [`ConnectionError`] on encode or framing failure.
pub async fn write_server_frame<W>(
    writer: &mut W,
    frame: &ServerFrame,
) -> Result<(), ConnectionError>
where
    W: AsyncWrite + Unpin,
{
    let payload = encode_server_frame(frame);
    write_frame(writer, &payload).await?;
    Ok(())
}
