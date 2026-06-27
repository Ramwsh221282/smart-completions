use core_types::{DocumentVersion, FileMode, Range};

/// Full document snapshot sent once when the editor first opens a document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitialDocumentSnapshot {
    /// Monaco document URI used as the store key.
    pub uri: String,
    /// Document version the text corresponds to.
    pub version: DocumentVersion,
    /// Editor language id (typescript, rust, ...).
    pub language_id: String,
    /// Workspace-relative path when the document is backed by a file.
    pub file_path: Option<String>,
    /// Whether the document is code or prose.
    pub file_mode: FileMode,
    /// Full document text.
    pub text: String,
}

/// One Monaco content change inside a change batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentContentChange {
    /// Replaced range in line/column coordinates.
    pub range: Range,
    /// Length in UTF-16 code units Monaco reports for the replaced range.
    pub range_length: u32,
    /// Text inserted in place of the range.
    pub inserted_text: String,
}
