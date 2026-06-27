//! Wire protocol for the Node <-> Rust core boundary.
//!
//! The active encoding is FlatBuffers via the generated `sc::*` schema types.
//! These higher-level DTOs keep the rest of the core agnostic to the binary
//! format while the transport layer stays length-prefixed and streaming.

use crate::generated::sc;
use core_types::{CompletionMode, DocumentVersion, FileMode, Position, Range, RequestId};
use planus::ReadAsRoot;
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
    /// FlatBuffers serialization or deserialization failure.
    #[error("flatbuffers error: {0}")]
    Flatbuffers(#[from] planus::Error),

    /// The frame omitted a field this transitional DTO still requires.
    #[error("missing field `{0}`")]
    MissingField(&'static str),

    /// The frame kind is defined in schema but not handled by the active DTO.
    #[error("unsupported server frame kind `{0}`")]
    UnsupportedServerFrameKind(&'static str),
}

/// Encodes a client frame to FlatBuffers bytes.
#[must_use]
pub fn encode_client_frame(frame: &ClientFrame) -> Vec<u8> {
    let generated = to_generated_client_frame(frame);
    let mut builder = planus::Builder::new();
    builder.finish(&generated, None).to_vec()
}

/// Decodes a client frame from FlatBuffers bytes.
///
/// # Errors
/// Returns [`ProtocolError`] when the payload is not a valid client frame.
pub fn decode_client_frame(bytes: &[u8]) -> Result<ClientFrame, ProtocolError> {
    let frame = sc::ClientFrameRef::read_as_root(bytes)?;
    let generated: sc::ClientFrame = frame.try_into()?;
    from_generated_client_frame(generated)
}

/// Encodes a server frame to FlatBuffers bytes.
#[must_use]
pub fn encode_server_frame(frame: &ServerFrame) -> Vec<u8> {
    let generated = to_generated_server_frame(frame);
    let mut builder = planus::Builder::new();
    builder.finish(&generated, None).to_vec()
}

/// Decodes a server frame from FlatBuffers bytes.
///
/// # Errors
/// Returns [`ProtocolError`] when the payload is not a valid server frame.
pub fn decode_server_frame(bytes: &[u8]) -> Result<ServerFrame, ProtocolError> {
    let frame = sc::StreamFrameRef::read_as_root(bytes)?;
    let generated: sc::StreamFrame = frame.try_into()?;
    from_generated_server_frame(generated)
}

fn to_generated_client_frame(frame: &ClientFrame) -> sc::ClientFrame {
    match frame {
        ClientFrame::InitialDocumentSnapshot(doc) => sc::ClientFrame {
            kind: sc::ClientFrameKind::InitialDocumentSnapshot,
            initial_document: Some(Box::new(to_generated_initial_document(doc))),
            document_change: None,
            open_buffer: None,
            request: None,
            cancel: None,
            config_update: None,
            shutdown: None,
        },
        ClientFrame::DocumentChange(change) => sc::ClientFrame {
            kind: sc::ClientFrameKind::DocumentChange,
            initial_document: None,
            document_change: Some(Box::new(to_generated_document_change(change))),
            open_buffer: None,
            request: None,
            cancel: None,
            config_update: None,
            shutdown: None,
        },
        ClientFrame::OpenBufferSnapshot(doc) => sc::ClientFrame {
            kind: sc::ClientFrameKind::OpenBufferSnapshot,
            initial_document: None,
            document_change: None,
            open_buffer: Some(Box::new(to_generated_open_buffer(doc))),
            request: None,
            cancel: None,
            config_update: None,
            shutdown: None,
        },
        ClientFrame::CompletionRequest(request) => sc::ClientFrame {
            kind: sc::ClientFrameKind::CompletionRequest,
            initial_document: None,
            document_change: None,
            open_buffer: None,
            request: Some(Box::new(to_generated_completion_request(request))),
            cancel: None,
            config_update: None,
            shutdown: None,
        },
        ClientFrame::Cancel(cancel) => sc::ClientFrame {
            kind: sc::ClientFrameKind::Cancel,
            initial_document: None,
            document_change: None,
            open_buffer: None,
            request: None,
            cancel: Some(Box::new(sc::Cancel {
                request_id: cancel.request_id,
            })),
            config_update: None,
            shutdown: None,
        },
        ClientFrame::ConfigUpdate(update) => sc::ClientFrame {
            kind: sc::ClientFrameKind::ConfigUpdate,
            initial_document: None,
            document_change: None,
            open_buffer: None,
            request: None,
            cancel: None,
            config_update: Some(Box::new(sc::ConfigUpdate {
                config_version: update.config_version,
                config_json: Some(update.config_json.clone()),
            })),
            shutdown: None,
        },
        ClientFrame::Shutdown(shutdown) => sc::ClientFrame {
            kind: sc::ClientFrameKind::Shutdown,
            initial_document: None,
            document_change: None,
            open_buffer: None,
            request: None,
            cancel: None,
            config_update: None,
            shutdown: Some(Box::new(sc::Shutdown {
                reason: Some(shutdown.reason.clone()),
            })),
        },
    }
}

fn from_generated_client_frame(frame: sc::ClientFrame) -> Result<ClientFrame, ProtocolError> {
    match frame.kind {
        sc::ClientFrameKind::InitialDocumentSnapshot => Ok(ClientFrame::InitialDocumentSnapshot(
            from_generated_initial_document(require_box(
                frame.initial_document,
                "client.initial_document",
            )?)?,
        )),
        sc::ClientFrameKind::DocumentChange => {
            Ok(ClientFrame::DocumentChange(from_generated_document_change(
                require_box(frame.document_change, "client.document_change")?,
            )?))
        }
        sc::ClientFrameKind::OpenBufferSnapshot => Ok(ClientFrame::OpenBufferSnapshot(
            from_generated_open_buffer(require_box(frame.open_buffer, "client.open_buffer")?)?,
        )),
        sc::ClientFrameKind::CompletionRequest => Ok(ClientFrame::CompletionRequest(
            from_generated_completion_request(require_box(frame.request, "client.request")?)?,
        )),
        sc::ClientFrameKind::Cancel => Ok(ClientFrame::Cancel(WireCancel {
            request_id: require_box(frame.cancel, "client.cancel")?.request_id,
        })),
        sc::ClientFrameKind::ConfigUpdate => {
            let update = require_box(frame.config_update, "client.config_update")?;
            Ok(ClientFrame::ConfigUpdate(WireConfigUpdate {
                config_version: update.config_version,
                config_json: require_value(update.config_json, "config_update.config_json")?,
            }))
        }
        sc::ClientFrameKind::Shutdown => {
            let shutdown = require_box(frame.shutdown, "client.shutdown")?;
            Ok(ClientFrame::Shutdown(WireShutdown {
                reason: require_value(shutdown.reason, "shutdown.reason")?,
            }))
        }
    }
}

fn to_generated_server_frame(frame: &ServerFrame) -> sc::StreamFrame {
    match frame {
        ServerFrame::Token { request_id, text } => sc::StreamFrame {
            request_id: *request_id,
            kind: sc::FrameKind::Token,
            text: Some(text.clone()),
            edit_range_start_line: 0,
            edit_range_start_col: 0,
            edit_range_end_line: 0,
            edit_range_end_col: 0,
            new_text: None,
            jump_line: 0,
            jump_col: 0,
        },
        ServerFrame::Done { request_id } => sc::StreamFrame {
            request_id: *request_id,
            kind: sc::FrameKind::Done,
            text: None,
            edit_range_start_line: 0,
            edit_range_start_col: 0,
            edit_range_end_line: 0,
            edit_range_end_col: 0,
            new_text: None,
            jump_line: 0,
            jump_col: 0,
        },
        ServerFrame::Error {
            request_id,
            message,
        } => sc::StreamFrame {
            request_id: *request_id,
            kind: sc::FrameKind::Error,
            text: Some(message.clone()),
            edit_range_start_line: 0,
            edit_range_start_col: 0,
            edit_range_end_line: 0,
            edit_range_end_col: 0,
            new_text: None,
            jump_line: 0,
            jump_col: 0,
        },
        ServerFrame::Edit {
            request_id,
            range,
            new_text,
            jump,
        } => sc::StreamFrame {
            request_id: *request_id,
            kind: sc::FrameKind::Edit,
            text: None,
            edit_range_start_line: range.start_line,
            edit_range_start_col: range.start_col,
            edit_range_end_line: range.end_line,
            edit_range_end_col: range.end_col,
            new_text: Some(new_text.clone()),
            jump_line: jump.map_or(0, |position| position.line),
            jump_col: jump.map_or(0, |position| position.column),
        },
    }
}

fn from_generated_server_frame(frame: sc::StreamFrame) -> Result<ServerFrame, ProtocolError> {
    match frame.kind {
        sc::FrameKind::Token => Ok(ServerFrame::Token {
            request_id: frame.request_id,
            text: frame.text.unwrap_or_default(),
        }),
        sc::FrameKind::Done => Ok(ServerFrame::Done {
            request_id: frame.request_id,
        }),
        sc::FrameKind::Error => Ok(ServerFrame::Error {
            request_id: frame.request_id,
            message: frame.text.unwrap_or_default(),
        }),
        sc::FrameKind::Edit => {
            let jump = jump_from_generated_frame(&frame);

            Ok(ServerFrame::Edit {
                request_id: frame.request_id,
                range: Range {
                    start_line: frame.edit_range_start_line,
                    start_col: frame.edit_range_start_col,
                    end_line: frame.edit_range_end_line,
                    end_col: frame.edit_range_end_col,
                },
                new_text: frame.new_text.unwrap_or_default(),
                jump,
            })
        }
        sc::FrameKind::Progress => Err(ProtocolError::UnsupportedServerFrameKind("Progress")),
    }
}

fn to_generated_initial_document(doc: &WireInitialDocument) -> sc::InitialDocumentSnapshot {
    sc::InitialDocumentSnapshot {
        uri: Some(doc.uri.clone()),
        version: doc.version,
        language_id: Some(doc.language_id.clone()),
        file_path: doc.file_path.clone(),
        file_mode: to_generated_file_mode(doc.file_mode),
        kind: sc::DocumentKind::File,
        text: Some(doc.text.clone()),
    }
}

fn from_generated_initial_document(
    doc: sc::InitialDocumentSnapshot,
) -> Result<WireInitialDocument, ProtocolError> {
    Ok(WireInitialDocument {
        uri: require_value(doc.uri, "initial_document.uri")?,
        version: doc.version,
        language_id: require_value(doc.language_id, "initial_document.language_id")?,
        file_path: doc.file_path,
        file_mode: from_generated_file_mode(doc.file_mode),
        text: require_value(doc.text, "initial_document.text")?,
    })
}

fn to_generated_open_buffer(doc: &WireInitialDocument) -> sc::OpenBufferSnapshot {
    sc::OpenBufferSnapshot {
        uri: Some(doc.uri.clone()),
        version: doc.version,
        language_id: Some(doc.language_id.clone()),
        file_mode: to_generated_file_mode(doc.file_mode),
        text: Some(doc.text.clone()),
    }
}

fn from_generated_open_buffer(
    doc: sc::OpenBufferSnapshot,
) -> Result<WireInitialDocument, ProtocolError> {
    Ok(WireInitialDocument {
        uri: require_value(doc.uri, "open_buffer.uri")?,
        version: doc.version,
        language_id: require_value(doc.language_id, "open_buffer.language_id")?,
        file_path: None,
        file_mode: from_generated_file_mode(doc.file_mode),
        text: require_value(doc.text, "open_buffer.text")?,
    })
}

fn to_generated_document_change(change: &WireDocumentChange) -> sc::DocumentChange {
    sc::DocumentChange {
        uri: Some(change.uri.clone()),
        from_version: change.from_version,
        to_version: change.to_version,
        changes: Some(to_generated_text_changes(&change.changes)),
    }
}

fn from_generated_document_change(
    change: sc::DocumentChange,
) -> Result<WireDocumentChange, ProtocolError> {
    Ok(WireDocumentChange {
        uri: require_value(change.uri, "document_change.uri")?,
        from_version: change.from_version,
        to_version: change.to_version,
        changes: change
            .changes
            .unwrap_or_default()
            .into_iter()
            .map(from_generated_text_change)
            .collect::<Result<Vec<_>, _>>()?,
    })
}

fn to_generated_text_changes(changes: &[WireTextChange]) -> Vec<sc::TextChange> {
    let mut out = Vec::with_capacity(changes.len());
    for change in changes {
        out.push(to_generated_text_change(change));
    }
    out
}

fn to_generated_text_change(change: &WireTextChange) -> sc::TextChange {
    sc::TextChange {
        range: Some(Box::new(to_generated_range(change.range))),
        range_length: change.range_length,
        inserted_text: Some(change.inserted_text.clone()),
    }
}

fn from_generated_text_change(change: sc::TextChange) -> Result<WireTextChange, ProtocolError> {
    Ok(WireTextChange {
        range: from_generated_range(&require_box(change.range, "text_change.range")?),
        range_length: change.range_length,
        inserted_text: require_value(change.inserted_text, "text_change.inserted_text")?,
    })
}

fn to_generated_completion_request(request: &WireCompletionRequest) -> sc::CompletionRequest {
    sc::CompletionRequest {
        request_id: request.request_id,
        mode: to_generated_completion_mode(request.mode),
        model_id: Some(request.model_id.clone()),
        uri: Some(request.uri.clone()),
        version: request.version,
        language_id: None,
        file_mode: to_generated_file_mode(request.file_mode),
        cursor: Some(Box::new(to_generated_position(request.cursor))),
        editable_region: None,
        recent_edit_uris: None,
        diagnostics: None,
        outline: None,
        related_file_hints: None,
        signals: None,
        config_version: request.config_version,
        config_json: None,
    }
}

fn from_generated_completion_request(
    request: sc::CompletionRequest,
) -> Result<WireCompletionRequest, ProtocolError> {
    Ok(WireCompletionRequest {
        request_id: request.request_id,
        mode: from_generated_completion_mode(request.mode),
        model_id: require_value(request.model_id, "completion_request.model_id")?,
        uri: require_value(request.uri, "completion_request.uri")?,
        version: request.version,
        file_mode: from_generated_file_mode(request.file_mode),
        cursor: from_generated_position(&require_box(request.cursor, "completion_request.cursor")?),
        config_version: request.config_version,
    })
}

fn to_generated_range(range: Range) -> sc::Range {
    sc::Range {
        start_line: range.start_line,
        start_col: range.start_col,
        end_line: range.end_line,
        end_col: range.end_col,
    }
}

fn from_generated_range(range: &sc::Range) -> Range {
    Range {
        start_line: range.start_line,
        start_col: range.start_col,
        end_line: range.end_line,
        end_col: range.end_col,
    }
}

fn to_generated_position(position: Position) -> sc::Position {
    sc::Position {
        line: position.line,
        column: position.column,
        offset: position.offset,
    }
}

fn from_generated_position(position: &sc::Position) -> Position {
    Position {
        line: position.line,
        column: position.column,
        offset: position.offset,
    }
}

fn to_generated_completion_mode(mode: CompletionMode) -> sc::Mode {
    match mode {
        CompletionMode::Fim => sc::Mode::Fim,
        CompletionMode::Nes => sc::Mode::Nes,
    }
}

fn from_generated_completion_mode(mode: sc::Mode) -> CompletionMode {
    match mode {
        sc::Mode::Fim => CompletionMode::Fim,
        sc::Mode::Nes => CompletionMode::Nes,
    }
}

fn to_generated_file_mode(mode: FileMode) -> sc::FileMode {
    match mode {
        FileMode::Code => sc::FileMode::Code,
        FileMode::Prose => sc::FileMode::Prose,
    }
}

fn from_generated_file_mode(mode: sc::FileMode) -> FileMode {
    match mode {
        sc::FileMode::Code => FileMode::Code,
        sc::FileMode::Prose => FileMode::Prose,
    }
}

fn jump_from_generated_frame(frame: &sc::StreamFrame) -> Option<Position> {
    if frame.jump_line == 0 && frame.jump_col == 0 {
        return None;
    }

    Some(Position {
        line: frame.jump_line,
        column: frame.jump_col,
        offset: 0,
    })
}

fn require_box<T>(value: Option<Box<T>>, field: &'static str) -> Result<T, ProtocolError> {
    Ok(*value.ok_or(ProtocolError::MissingField(field))?)
}

fn require_value<T>(value: Option<T>, field: &'static str) -> Result<T, ProtocolError> {
    value.ok_or(ProtocolError::MissingField(field))
}
