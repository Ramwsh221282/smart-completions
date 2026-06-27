//! IPC transport for the Node <-> Rust core boundary.
//!
//! Layers: length-prefixed framing, a serde wire protocol (transitional JSON,
//! FlatBuffers via planus is the target), and a connection serving loop with a
//! Unix-socket listener. Windows named pipes land on the cross-platform phase.

pub mod connection;
pub mod framing;
pub mod protocol;
pub mod server;

pub use connection::{
    read_client_frame, read_server_frame, write_client_frame, write_server_frame, ConnectionError,
};
pub use framing::{read_frame, write_frame, FrameError};
pub use protocol::{
    decode_client_frame, decode_server_frame, encode_client_frame, encode_server_frame,
    ClientFrame, ProtocolError, ServerFrame, WireCancel, WireCompletionRequest, WireConfigUpdate,
    WireDocumentChange, WireInitialDocument, WireShutdown, WireTextChange,
};
pub use server::{serve_connection, ConnectionEnd, FrameHandler, HandlerOutcome};

#[cfg(unix)]
pub use server::serve_unix_socket;
