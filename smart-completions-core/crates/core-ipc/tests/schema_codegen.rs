//! Verifies the planus-generated FlatBuffers types build and round-trip.

use core_ipc::generated::sc::{Cancel, CancelRef, FrameKind, StreamFrame, StreamFrameRef};
use planus::ReadAsRoot;

#[test]
fn stream_frame_roundtrips_through_flatbuffers() {
    let mut builder = planus::Builder::new();
    let frame = StreamFrame {
        request_id: 7,
        kind: FrameKind::Token,
        text: Some("hi".to_string()),
        ..Default::default()
    };

    let bytes = builder.finish(&frame, None);
    let read = StreamFrameRef::read_as_root(bytes).unwrap();

    assert_eq!(read.request_id().unwrap(), 7);
    assert_eq!(read.kind().unwrap(), FrameKind::Token);
    assert_eq!(read.text().unwrap(), Some("hi"));
}

#[test]
fn cancel_frame_roundtrips_through_flatbuffers() {
    let mut builder = planus::Builder::new();
    let cancel = Cancel { request_id: 42 };

    let bytes = builder.finish(&cancel, None);
    let read = CancelRef::read_as_root(bytes).unwrap();

    assert_eq!(read.request_id().unwrap(), 42);
}
