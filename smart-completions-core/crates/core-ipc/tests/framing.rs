//! Integration tests for length-prefixed framing.

use bytes::BytesMut;
use core_ipc::framing::FrameError;
use core_ipc::{read_frame, write_frame};
use tokio::io::{duplex, AsyncWriteExt};

#[tokio::test]
async fn writes_and_reads_length_prefixed_frame() {
    let (mut client, mut server) = duplex(64);

    let writer = tokio::spawn(async move {
        write_frame(&mut client, b"hello").await.unwrap();
    });

    let mut scratch = BytesMut::new();
    let payload = read_frame(&mut server, &mut scratch).await.unwrap();

    writer.await.unwrap();
    assert_eq!(&payload[..], b"hello");
}

#[tokio::test]
async fn rejects_oversized_advertised_length() {
    let (mut client, mut server) = duplex(64);

    let writer = tokio::spawn(async move {
        client.write_all(&u32::MAX.to_le_bytes()).await.unwrap();
        client.flush().await.unwrap();
    });

    let mut scratch = BytesMut::new();
    let result = read_frame(&mut server, &mut scratch).await;

    writer.await.unwrap();
    assert!(matches!(result, Err(FrameError::FrameTooLarge(_))));
}
