//! IPC transport for the Node <-> Rust core boundary.
//!
//! This phase provides length-prefixed framing only. FlatBuffers payload
//! codegen (planus) and the interprocess local-socket server land in the IPC
//! schema phase described in implementation.md, on top of this framing.

pub mod framing;

pub use framing::{read_frame, write_frame, FrameError};
