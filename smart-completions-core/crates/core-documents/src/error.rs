use core_types::DocumentVersion;

/// Result alias for document store operations.
pub type DocumentResult<T> = Result<T, DocumentError>;

/// Failure modes when synchronizing or reading a shadow document.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DocumentError {
    /// The document was never synchronized with an initial snapshot.
    #[error("document is not synchronized: {uri}")]
    MissingDocument {
        /// URI that was requested.
        uri: String,
    },

    /// The requested base version does not match the stored version.
    #[error("version mismatch for {uri}: expected {expected}, actual {actual}")]
    VersionMismatch {
        /// URI that was requested.
        uri: String,
        /// Version the caller expected.
        expected: DocumentVersion,
        /// Version currently stored.
        actual: DocumentVersion,
    },

    /// A range or cursor could not be resolved inside the current text.
    #[error("invalid range for {uri}")]
    InvalidRange {
        /// URI that was requested.
        uri: String,
    },
}
