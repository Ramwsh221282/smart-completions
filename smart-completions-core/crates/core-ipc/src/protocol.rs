//! Wire protocol for the Node <-> Rust core boundary.
//!
//! Frames are adjacently tagged JSON (`{ "kind": ..., "data": ... }`) for the
//! transitional smoke. The target encoding is FlatBuffers via planus; the frame
//! shapes here mirror `schema/*.fbs` so the switch is mechanical.

use core_types::{CompletionMode, DocumentVersion, FileMode, Position, Range, RequestId};
use serde::{Deserialize, Serialize};

/// One Monaco content change on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireTextChange {
    /// Replaced range.
    pub range: Range,
    /// Length in UTF-16 code units Monaco reports.
    pub range_length: u32,
    /// Inserted text.
    pub inserted_text: String,
}

/// Full document snapshot on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireInitialDocument {
    /// Document URI.
    pub uri: String,
    /// Document version.
    pub version: DocumentVersion,
    /// Editor language id.
    pub language_id: String,
    /// Workspace-relative path when backed by a file.
    pub file_path: Option<String>,
    /// Whether the document is code or prose.
    pub file_mode: FileMode,
    /// Full document text.
    pub text: String,
}

/// Incremental document change batch on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireDocumentChange {
    /// Document URI.
    pub uri: String,
    /// Version the changes apply on top of.
    pub from_version: DocumentVersion,
    /// Version after applying the changes.
    pub to_version: DocumentVersion,
    /// Ordered content changes.
    pub changes: Vec<WireTextChange>,
}

/// A completion request on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireCompletionRequest {
    /// Request identity for cancellation and stream correlation.
    pub request_id: RequestId,
    /// Which pipeline to run.
    pub mode: CompletionMode,
    /// Model id selecting the module.
    pub model_id: String,
    /// Document the request targets.
    pub uri: String,
    /// Document version the request was built against.
    pub version: DocumentVersion,
    /// Whether the document is code or prose.
    pub file_mode: FileMode,
    /// Cursor position.
    pub cursor: Position,
    /// Config version the request assumes.
    pub config_version: u64,
}

/// A cancellation request on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireCancel {
    /// Request to cancel.
    pub request_id: RequestId,
}

/// A configuration update on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireConfigUpdate {
    /// New config version.
    pub config_version: u64,
    /// Serialized config payload.
    pub config_json: String,
}

/// A shutdown request on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireShutdown {
    /// Reason for shutdown.
    pub reason: String,
}

/// A frame sent from Node to the core.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum ClientFrame {
    /// Full document snapshot for a freshly opened document.
    InitialDocumentSnapshot(WireInitialDocument),
    /// Incremental change batch.
    DocumentChange(WireDocumentChange),
    /// Snapshot for an unsaved or untitled buffer.
    OpenBufferSnapshot(WireInitialDocument),
    /// Request a completion.
    CompletionRequest(WireCompletionRequest),
    /// Cancel an in-flight request.
    Cancel(WireCancel),
    /// Update configuration.
    ConfigUpdate(WireConfigUpdate),
    /// Ask the core to shut down.
    Shutdown(WireShutdown),
}

/// A frame sent from the core back to Node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum ServerFrame {
    /// A streamed completion token.
    Token {
        /// Request the token belongs to.
        request_id: RequestId,
        /// Token text.
        text: String,
    },
    /// A request finished successfully.
    Done {
        /// Request that finished.
        request_id: RequestId,
    },
    /// A request failed.
    Error {
        /// Request that failed.
        request_id: RequestId,
        /// Failure message.
        message: String,
    },
    /// A next-edit suggestion edit.
    Edit {
        /// Request the edit belongs to.
        request_id: RequestId,
        /// Range to replace.
        range: Range,
        /// Replacement text.
        new_text: String,
        /// Optional cursor jump target.
        jump: Option<Position>,
    },
}

/// Errors while encoding or decoding wire frames.
#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    /// JSON serialization or deserialization failure.
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Encodes a client frame to JSON bytes.
///
/// # Errors
/// Returns [`ProtocolError`] when serialization fails.
pub fn encode_client_frame(frame: &ClientFrame) -> Result<Vec<u8>, ProtocolError> {
    Ok(serde_json::to_vec(frame)?)
}

/// Decodes a client frame from JSON bytes.
///
/// # Errors
/// Returns [`ProtocolError`] when the payload is not a valid client frame.
pub fn decode_client_frame(bytes: &[u8]) -> Result<ClientFrame, ProtocolError> {
    Ok(serde_json::from_slice(bytes)?)
}

/// Encodes a server frame to JSON bytes.
///
/// # Errors
/// Returns [`ProtocolError`] when serialization fails.
pub fn encode_server_frame(frame: &ServerFrame) -> Result<Vec<u8>, ProtocolError> {
    Ok(serde_json::to_vec(frame)?)
}

/// Decodes a server frame from JSON bytes.
///
/// # Errors
/// Returns [`ProtocolError`] when the payload is not a valid server frame.
pub fn decode_server_frame(bytes: &[u8]) -> Result<ServerFrame, ProtocolError> {
    Ok(serde_json::from_slice(bytes)?)
}
