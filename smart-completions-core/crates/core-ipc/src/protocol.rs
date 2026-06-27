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

/// Whether the snapshot came from a file or an untitled buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WireDocumentKind {
    /// File-backed document snapshot.
    File,
    /// Untitled or unsaved buffer snapshot.
    Untitled,
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
    /// Whether the snapshot is file-backed or untitled.
    pub kind: WireDocumentKind,
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

/// Diagnostic severity preserved across the transport boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WireDiagnosticSeverity {
    /// Error diagnostic.
    Error,
    /// Warning diagnostic.
    Warning,
    /// Informational diagnostic.
    Info,
    /// Hint diagnostic.
    Hint,
}

/// Diagnostic hint sent as raw context, not rendered prompt text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireDiagnostic {
    /// Affected range.
    pub range: Range,
    /// Diagnostic severity.
    pub severity: WireDiagnosticSeverity,
    /// User-facing message.
    pub message: String,
    /// Optional diagnostic code.
    pub code: Option<String>,
}

/// Outline item gathered on the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireOutlineItem {
    /// Symbol name.
    pub name: String,
    /// Symbol kind label.
    pub kind: String,
    /// Full symbol range.
    pub range: Range,
    /// More precise selection range when available.
    pub selection_range: Range,
}

/// Related-file pointer that lets the core load and rank context itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WireRelatedFileHint {
    /// Workspace-relative path.
    pub path: String,
    /// Optional range of interest inside the file.
    pub range: Option<Range>,
    /// Origin of the hint.
    pub source: String,
    /// Source-provided score used as a tie-breaker.
    pub score_hint: f32,
}

/// Raw retrieval/query signals gathered on the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireSignals {
    /// Symbol under the cursor when known.
    pub symbol_at_cursor: Option<String>,
    /// Recently renamed symbols.
    pub renamed_symbols: Vec<String>,
    /// Imported symbols from the current view.
    pub imported_symbols: Vec<String>,
    /// Declared type names near the edit.
    pub declared_types: Vec<String>,
    /// Test names near the edit.
    pub test_names: Vec<String>,
    /// Symbols extracted from diagnostics.
    pub diagnostic_symbols: Vec<String>,
    /// Fuzzy-ranked symbol candidates.
    pub fuzzy_symbols: Vec<String>,
    /// Additional retrieval hints already normalized by the frontend.
    pub retrieval_signal_hints: Vec<String>,
}

/// Compact recent edit payload forwarded to the Rust core.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireRecentEdit {
    /// URI of the edited document.
    pub uri: String,
    /// Compact unified diff.
    pub unified_diff: String,
    /// Edit timestamp in Unix milliseconds.
    pub timestamp: u64,
}

/// A completion request on the wire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    /// Editor language id.
    pub language_id: String,
    /// Whether the document is code or prose.
    pub file_mode: FileMode,
    /// Cursor position.
    pub cursor: Position,
    /// Optional frontend-selected editable region.
    pub editable_region: Option<Range>,
    /// URIs of recent edits already tracked by the frontend.
    pub recent_edit_uris: Vec<String>,
    /// Compact recent edits forwarded for original-window reconstruction.
    pub recent_edits: Vec<WireRecentEdit>,
    /// Optional original window captured before the latest edit.
    pub original_window_text: Option<String>,
    /// Diagnostics gathered near the request.
    pub diagnostics: Vec<WireDiagnostic>,
    /// Outline items describing the active file structure.
    pub outline: Vec<WireOutlineItem>,
    /// Related-file pointers.
    pub related_file_hints: Vec<WireRelatedFileHint>,
    /// Raw retrieval/query signals.
    pub signals: Option<WireSignals>,
    /// Config version the request assumes.
    pub config_version: u64,
    /// Optional serialized config payload.
    pub config_json: Option<String>,
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ClientFrame {
    /// Full document snapshot for a freshly opened document.
    InitialDocumentSnapshot(WireInitialDocument),
    /// Incremental change batch.
    DocumentChange(WireDocumentChange),
    /// Snapshot for an unsaved or untitled buffer.
    OpenBufferSnapshot(WireInitialDocument),
    /// Request a completion.
    ///
    /// Boxed to keep the transport enum compact after the full envelope landed.
    CompletionRequest(Box<WireCompletionRequest>),
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
    /// A progress/status update that does not finish the request.
    Progress {
        /// Request the update belongs to.
        request_id: RequestId,
        /// Human-readable status text.
        text: String,
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

    /// The frame omitted a field this high-level DTO still requires.
    #[error("missing field `{0}`")]
    MissingField(&'static str),
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
    Ok(from_generated_server_frame(generated))
}

// Generated schema types stay isolated here so the rest of the core can keep
// using stable Wire* DTOs instead of planus-specific table shapes.
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
        sc::ClientFrameKind::CompletionRequest => Ok(ClientFrame::CompletionRequest(Box::new(
            from_generated_completion_request(require_box(frame.request, "client.request")?)?,
        ))),
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

// Stream frames use the same boundary-only conversion so socket handling and
// application logic never depend on generated accessors directly.
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
        ServerFrame::Progress { request_id, text } => sc::StreamFrame {
            request_id: *request_id,
            kind: sc::FrameKind::Progress,
            text: Some(text.clone()),
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

// Every schema `FrameKind` maps to a `ServerFrame`, so this conversion is
// total: missing optional strings default to empty rather than failing.
fn from_generated_server_frame(frame: sc::StreamFrame) -> ServerFrame {
    match frame.kind {
        sc::FrameKind::Token => ServerFrame::Token {
            request_id: frame.request_id,
            text: frame.text.unwrap_or_default(),
        },
        sc::FrameKind::Done => ServerFrame::Done {
            request_id: frame.request_id,
        },
        sc::FrameKind::Error => ServerFrame::Error {
            request_id: frame.request_id,
            message: frame.text.unwrap_or_default(),
        },
        sc::FrameKind::Progress => ServerFrame::Progress {
            request_id: frame.request_id,
            text: frame.text.unwrap_or_default(),
        },
        sc::FrameKind::Edit => {
            let jump = jump_from_generated_frame(&frame);

            ServerFrame::Edit {
                request_id: frame.request_id,
                range: Range {
                    start_line: frame.edit_range_start_line,
                    start_col: frame.edit_range_start_col,
                    end_line: frame.edit_range_end_line,
                    end_col: frame.edit_range_end_col,
                },
                new_text: frame.new_text.unwrap_or_default(),
                jump,
            }
        }
    }
}

fn to_generated_initial_document(doc: &WireInitialDocument) -> sc::InitialDocumentSnapshot {
    sc::InitialDocumentSnapshot {
        uri: Some(doc.uri.clone()),
        version: doc.version,
        language_id: Some(doc.language_id.clone()),
        file_path: doc.file_path.clone(),
        file_mode: to_generated_file_mode(doc.file_mode),
        kind: to_generated_document_kind(doc.kind),
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
        kind: from_generated_document_kind(doc.kind),
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
        kind: WireDocumentKind::Untitled,
        text: require_value(doc.text, "open_buffer.text")?,
    })
}

fn to_generated_document_change(change: &WireDocumentChange) -> sc::DocumentChange {
    sc::DocumentChange {
        uri: Some(change.uri.clone()),
        from_version: change.from_version,
        to_version: change.to_version,
        changes: vec_if_nonempty(to_generated_text_changes(&change.changes)),
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

// The schema is richer than the current handlers, so this mapper centralizes
// which empty sections are omitted versus sent as real values on the wire.
fn to_generated_completion_request(request: &WireCompletionRequest) -> sc::CompletionRequest {
    sc::CompletionRequest {
        request_id: request.request_id,
        mode: to_generated_completion_mode(request.mode),
        model_id: Some(request.model_id.clone()),
        uri: Some(request.uri.clone()),
        version: request.version,
        language_id: Some(request.language_id.clone()),
        file_mode: to_generated_file_mode(request.file_mode),
        cursor: Some(Box::new(to_generated_position(request.cursor))),
        editable_region: request
            .editable_region
            .map(|range| Box::new(to_generated_range(range))),
        recent_edit_uris: vec_if_nonempty(request.recent_edit_uris.clone()),
        recent_edits: vec_if_nonempty(to_generated_recent_edits(&request.recent_edits)),
        original_window_text: request.original_window_text.clone(),
        diagnostics: vec_if_nonempty(to_generated_diagnostics(&request.diagnostics)),
        outline: vec_if_nonempty(to_generated_outline(&request.outline)),
        related_file_hints: vec_if_nonempty(to_generated_related_file_hints(
            &request.related_file_hints,
        )),
        signals: generated_signals(request.signals.as_ref()),
        config_version: request.config_version,
        config_json: request.config_json.clone(),
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
        language_id: require_value(request.language_id, "completion_request.language_id")?,
        file_mode: from_generated_file_mode(request.file_mode),
        cursor: from_generated_position(&require_box(request.cursor, "completion_request.cursor")?),
        editable_region: request
            .editable_region
            .map(|range| from_generated_range(&range)),
        recent_edit_uris: request.recent_edit_uris.unwrap_or_default(),
        recent_edits: request
            .recent_edits
            .unwrap_or_default()
            .into_iter()
            .map(from_generated_recent_edit)
            .collect::<Result<Vec<_>, _>>()?,
        original_window_text: request.original_window_text,
        diagnostics: request
            .diagnostics
            .unwrap_or_default()
            .into_iter()
            .map(from_generated_diagnostic)
            .collect::<Result<Vec<_>, _>>()?,
        outline: request
            .outline
            .unwrap_or_default()
            .into_iter()
            .map(from_generated_outline_item)
            .collect::<Result<Vec<_>, _>>()?,
        related_file_hints: request
            .related_file_hints
            .unwrap_or_default()
            .into_iter()
            .map(from_generated_related_file_hint)
            .collect::<Result<Vec<_>, _>>()?,
        signals: request
            .signals
            .map(|signals| from_generated_signals(&signals)),
        config_version: request.config_version,
        config_json: request.config_json,
    })
}

fn to_generated_diagnostics(diagnostics: &[WireDiagnostic]) -> Vec<sc::Diagnostic> {
    let mut out = Vec::with_capacity(diagnostics.len());
    for diagnostic in diagnostics {
        out.push(to_generated_diagnostic(diagnostic));
    }
    out
}

fn to_generated_recent_edits(edits: &[WireRecentEdit]) -> Vec<sc::RecentEdit> {
    let mut out = Vec::with_capacity(edits.len());
    for edit in edits {
        out.push(to_generated_recent_edit(edit));
    }
    out
}

fn to_generated_recent_edit(edit: &WireRecentEdit) -> sc::RecentEdit {
    sc::RecentEdit {
        uri: Some(edit.uri.clone()),
        unified_diff: Some(edit.unified_diff.clone()),
        timestamp: edit.timestamp,
    }
}

fn from_generated_recent_edit(edit: sc::RecentEdit) -> Result<WireRecentEdit, ProtocolError> {
    Ok(WireRecentEdit {
        uri: require_value(edit.uri, "recent_edit.uri")?,
        unified_diff: require_value(edit.unified_diff, "recent_edit.unified_diff")?,
        timestamp: edit.timestamp,
    })
}

fn to_generated_diagnostic(diagnostic: &WireDiagnostic) -> sc::Diagnostic {
    sc::Diagnostic {
        range: Some(Box::new(to_generated_range(diagnostic.range))),
        severity: diagnostic_severity_to_wire(diagnostic.severity),
        message: Some(diagnostic.message.clone()),
        code: diagnostic.code.clone(),
    }
}

fn from_generated_diagnostic(diagnostic: sc::Diagnostic) -> Result<WireDiagnostic, ProtocolError> {
    Ok(WireDiagnostic {
        range: from_generated_range(&require_box(diagnostic.range, "diagnostic.range")?),
        severity: diagnostic_severity_from_wire(diagnostic.severity),
        message: require_value(diagnostic.message, "diagnostic.message")?,
        code: diagnostic.code,
    })
}

fn to_generated_outline(items: &[WireOutlineItem]) -> Vec<sc::OutlineItem> {
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        out.push(to_generated_outline_item(item));
    }
    out
}

fn to_generated_outline_item(item: &WireOutlineItem) -> sc::OutlineItem {
    sc::OutlineItem {
        name: Some(item.name.clone()),
        kind: Some(item.kind.clone()),
        range: Some(Box::new(to_generated_range(item.range))),
        selection_range: Some(Box::new(to_generated_range(item.selection_range))),
    }
}

fn from_generated_outline_item(item: sc::OutlineItem) -> Result<WireOutlineItem, ProtocolError> {
    let range = from_generated_range(&require_box(item.range, "outline.range")?);

    Ok(WireOutlineItem {
        name: require_value(item.name, "outline.name")?,
        kind: require_value(item.kind, "outline.kind")?,
        selection_range: item
            .selection_range
            .as_ref()
            .map_or(range, |selection| from_generated_range(selection)),
        range,
    })
}

fn to_generated_related_file_hints(hints: &[WireRelatedFileHint]) -> Vec<sc::RelatedFileHint> {
    let mut out = Vec::with_capacity(hints.len());
    for hint in hints {
        out.push(to_generated_related_file_hint(hint));
    }
    out
}

fn to_generated_related_file_hint(hint: &WireRelatedFileHint) -> sc::RelatedFileHint {
    sc::RelatedFileHint {
        path: Some(hint.path.clone()),
        range: hint.range.map(|range| Box::new(to_generated_range(range))),
        source: Some(hint.source.clone()),
        score_hint: hint.score_hint,
    }
}

fn from_generated_related_file_hint(
    hint: sc::RelatedFileHint,
) -> Result<WireRelatedFileHint, ProtocolError> {
    Ok(WireRelatedFileHint {
        path: require_value(hint.path, "related_file_hint.path")?,
        range: hint.range.as_ref().map(|range| from_generated_range(range)),
        source: require_value(hint.source, "related_file_hint.source")?,
        score_hint: hint.score_hint,
    })
}

// Empty signals stay absent on the wire, which lets downstream code interpret
// missing metadata as "not collected" instead of "collected but empty".
fn generated_signals(signals: Option<&WireSignals>) -> Option<Box<sc::Signals>> {
    let signals = signals?;
    if signals_is_empty(signals) {
        return None;
    }

    Some(Box::new(to_generated_signals(signals)))
}

fn to_generated_signals(signals: &WireSignals) -> sc::Signals {
    sc::Signals {
        symbol_at_cursor: signals.symbol_at_cursor.clone(),
        renamed_symbols: vec_if_nonempty(signals.renamed_symbols.clone()),
        imported_symbols: vec_if_nonempty(signals.imported_symbols.clone()),
        declared_types: vec_if_nonempty(signals.declared_types.clone()),
        test_names: vec_if_nonempty(signals.test_names.clone()),
        diagnostic_symbols: vec_if_nonempty(signals.diagnostic_symbols.clone()),
        fuzzy_symbols: vec_if_nonempty(signals.fuzzy_symbols.clone()),
        retrieval_signal_hints: vec_if_nonempty(signals.retrieval_signal_hints.clone()),
    }
}

fn from_generated_signals(signals: &sc::Signals) -> WireSignals {
    WireSignals {
        symbol_at_cursor: signals.symbol_at_cursor.clone(),
        renamed_symbols: signals.renamed_symbols.clone().unwrap_or_default(),
        imported_symbols: signals.imported_symbols.clone().unwrap_or_default(),
        declared_types: signals.declared_types.clone().unwrap_or_default(),
        test_names: signals.test_names.clone().unwrap_or_default(),
        diagnostic_symbols: signals.diagnostic_symbols.clone().unwrap_or_default(),
        fuzzy_symbols: signals.fuzzy_symbols.clone().unwrap_or_default(),
        retrieval_signal_hints: signals.retrieval_signal_hints.clone().unwrap_or_default(),
    }
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

fn to_generated_document_kind(kind: WireDocumentKind) -> sc::DocumentKind {
    match kind {
        WireDocumentKind::File => sc::DocumentKind::File,
        WireDocumentKind::Untitled => sc::DocumentKind::Untitled,
    }
}

fn from_generated_document_kind(kind: sc::DocumentKind) -> WireDocumentKind {
    match kind {
        sc::DocumentKind::File => WireDocumentKind::File,
        sc::DocumentKind::Untitled => WireDocumentKind::Untitled,
    }
}

fn diagnostic_severity_to_wire(severity: WireDiagnosticSeverity) -> i8 {
    match severity {
        WireDiagnosticSeverity::Error => 0,
        WireDiagnosticSeverity::Warning => 1,
        WireDiagnosticSeverity::Info => 2,
        WireDiagnosticSeverity::Hint => 3,
    }
}

fn diagnostic_severity_from_wire(severity: i8) -> WireDiagnosticSeverity {
    match severity {
        1 => WireDiagnosticSeverity::Warning,
        2 => WireDiagnosticSeverity::Info,
        3 => WireDiagnosticSeverity::Hint,
        _ => WireDiagnosticSeverity::Error,
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

fn signals_is_empty(signals: &WireSignals) -> bool {
    signals.symbol_at_cursor.is_none()
        && signals.renamed_symbols.is_empty()
        && signals.imported_symbols.is_empty()
        && signals.declared_types.is_empty()
        && signals.test_names.is_empty()
        && signals.diagnostic_symbols.is_empty()
        && signals.fuzzy_symbols.is_empty()
        && signals.retrieval_signal_hints.is_empty()
}

// FlatBuffers omits empty vectors cleanly; keeping that policy in one helper
// avoids slightly different absence rules across the table mappers.
fn vec_if_nonempty<T>(values: Vec<T>) -> Option<Vec<T>> {
    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

// Some generated fields stay optional for forward-compatibility, but the
// current high-level DTOs still require them to be present at the boundary.
fn require_box<T>(value: Option<Box<T>>, field: &'static str) -> Result<T, ProtocolError> {
    Ok(*value.ok_or(ProtocolError::MissingField(field))?)
}

fn require_value<T>(value: Option<T>, field: &'static str) -> Result<T, ProtocolError> {
    value.ok_or(ProtocolError::MissingField(field))
}
