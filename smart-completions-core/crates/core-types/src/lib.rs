//! Shared value types for the Rust core.
//!
//! These mirror the editor DTOs the TypeScript side already speaks so the IPC
//! boundary can stay a thin envelope instead of re-deriving semantics.

use serde::{Deserialize, Serialize};

/// Stable identifier for an in-flight completion request.
pub type RequestId = u64;

/// Monaco document version counter.
pub type DocumentVersion = i32;

/// Which completion pipeline a request targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CompletionMode {
    /// Fill-in-the-middle ghost text.
    Fim,
    /// Next edit suggestion.
    Nes,
}

/// Whether a document is treated as source code or prose.
///
/// Prose mode relaxes trigger rules and disables code-only context.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FileMode {
    /// Source code buffer.
    Code,
    /// Natural-language buffer (markdown, plaintext).
    Prose,
}

/// Cursor position expressed in both line/column and absolute byte offset.
///
/// The offset is authoritative when greater than zero; line/column is the
/// fallback Monaco always provides.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Position {
    /// Zero-based line.
    pub line: i32,
    /// Zero-based column.
    pub column: i32,
    /// Absolute byte offset, or zero when unknown.
    pub offset: u32,
}

/// Half-open text range in line/column coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Range {
    /// Zero-based start line.
    pub start_line: i32,
    /// Zero-based start column.
    pub start_col: i32,
    /// Zero-based end line.
    pub end_line: i32,
    /// Zero-based end column.
    pub end_col: i32,
}

/// A retrieved context chunk produced by the retrieval channels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Neighbor {
    /// Stable identity used for cross-channel deduplication.
    pub id: String,
    /// Workspace-relative path the chunk originates from.
    pub file_path: String,
    /// Source range of the chunk.
    pub range: Range,
    /// Chunk text injected into prompts.
    pub text: String,
    /// Channel score; rewritten by fusion before ranking.
    pub score: f32,
}

impl Neighbor {
    /// Returns the identity used by fusion to merge duplicate hits.
    #[must_use]
    pub fn stable_id(&self) -> &str {
        &self.id
    }
}

/// A related-file pointer the frontend sends as a retrieval hint.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RelatedFileHint {
    /// Workspace-relative path of the related file.
    pub path: String,
    /// Optional range of interest inside the file.
    pub range: Option<Range>,
    /// Origin of the hint (search, hierarchy, scm, ...).
    pub source: String,
    /// Optional source-provided score used as a tie-breaker.
    pub score_hint: Option<f32>,
}
