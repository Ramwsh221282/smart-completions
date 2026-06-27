//! IPC transport for the Node <-> Rust core boundary.
//!
//! Layers: length-prefixed framing, a FlatBuffers wire protocol via planus, and
//! a connection serving loop with a Unix-socket listener. Windows named pipes
//! land on the cross-platform phase.

pub mod connection;
pub mod framing;
pub mod protocol;
pub mod server;

/// FlatBuffers types generated from `schema/*.fbs` by planus at build time.
#[rustfmt::skip]
#[allow(
    unsafe_code,
    missing_docs,
    unused_imports,
    unused_qualifications,
    clippy::all,
    clippy::pedantic,
    clippy::nursery,
    clippy::correctness,
    clippy::perf,
    clippy::style,
    clippy::complexity,
    clippy::suspicious,
    clippy::redundant_clone
)]
pub mod generated {
    include!(concat!(env!("OUT_DIR"), "/smart_completions_schema.rs"));
}

pub use connection::{
    read_client_frame, read_server_frame, write_client_frame, write_server_frame, ConnectionError,
};
pub use framing::{read_frame, write_frame, FrameError};
pub use protocol::{
    decode_client_frame, decode_server_frame, encode_client_frame, encode_server_frame,
    ClientFrame, ProtocolError, ServerFrame, WireCancel, WireCompletionRequest, WireConfigUpdate,
    WireDiagnostic, WireDiagnosticSeverity, WireDocumentChange, WireDocumentKind,
    WireInitialDocument, WireOutlineItem, WireRecentEdit, WireRelatedFileHint, WireShutdown,
    WireSignals, WireTextChange,
};
pub use server::{serve_connection, ConnectionEnd, FrameHandler, HandlerOutcome};

#[cfg(unix)]
pub use server::serve_unix_socket;
