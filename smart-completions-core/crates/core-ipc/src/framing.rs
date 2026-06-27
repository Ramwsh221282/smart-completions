//! Length-prefixed frame transport: a `u32` little-endian length then payload.

use bytes::{Buf, BufMut, BytesMut};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const LEN_BYTES: usize = 4;
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// Errors raised while reading or writing frames.
#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    /// Underlying transport I/O failure.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// A frame advertised or carried more bytes than allowed.
    #[error("frame is too large: {0} bytes")]
    FrameTooLarge(usize),
}

/// Reads one length-prefixed frame and returns its payload bytes.
///
/// `scratch` is reused across calls to avoid a per-frame allocation.
///
/// # Errors
/// Returns [`FrameError`] on I/O failure or when the advertised length exceeds
/// the maximum frame size.
pub async fn read_frame<R>(reader: &mut R, scratch: &mut BytesMut) -> Result<BytesMut, FrameError>
where
    R: AsyncRead + Unpin,
{
    read_len_prefix(reader, scratch).await?;
    let len = usize::try_from(scratch.get_u32_le()).unwrap_or(usize::MAX);
    ensure_allowed_len(len)?;

    scratch.resize(len, 0);
    reader.read_exact(scratch).await?;

    Ok(scratch.split_to(len))
}

/// Writes one length-prefixed frame.
///
/// # Errors
/// Returns [`FrameError`] on I/O failure or when the payload exceeds the
/// maximum frame size.
pub async fn write_frame<W>(writer: &mut W, payload: &[u8]) -> Result<(), FrameError>
where
    W: AsyncWrite + Unpin,
{
    ensure_allowed_len(payload.len())?;
    let len = u32::try_from(payload.len()).map_err(|_| FrameError::FrameTooLarge(payload.len()))?;

    let mut header = [0_u8; LEN_BYTES];
    (&mut header[..]).put_u32_le(len);

    writer.write_all(&header).await?;
    writer.write_all(payload).await?;
    writer.flush().await?;

    Ok(())
}

async fn read_len_prefix<R>(reader: &mut R, scratch: &mut BytesMut) -> Result<(), FrameError>
where
    R: AsyncRead + Unpin,
{
    scratch.resize(LEN_BYTES, 0);
    reader.read_exact(scratch).await?;
    Ok(())
}

fn ensure_allowed_len(len: usize) -> Result<(), FrameError> {
    if len <= MAX_FRAME_BYTES {
        return Ok(());
    }

    Err(FrameError::FrameTooLarge(len))
}
