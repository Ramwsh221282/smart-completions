use std::collections::HashMap;

use core_types::{DocumentVersion, Position, Range};

use crate::{DocumentContentChange, DocumentError, DocumentResult, InitialDocumentSnapshot};

/// Authoritative shadow copy of every synchronized editor document.
#[derive(Debug, Default)]
pub struct CoreDocumentStore {
    documents: HashMap<String, DocumentState>,
}

impl CoreDocumentStore {
    /// Creates an empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns how many documents are currently tracked.
    #[must_use]
    pub fn len(&self) -> usize {
        self.documents.len()
    }

    /// Returns whether the store tracks no documents.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.documents.is_empty()
    }

    /// Stores or replaces a document from a full snapshot.
    pub fn upsert_initial_snapshot(&mut self, snapshot: InitialDocumentSnapshot) {
        let state = DocumentState::new(snapshot.version, snapshot.file_path, snapshot.text);
        self.documents.insert(snapshot.uri, state);
    }

    /// Applies ordered Monaco content changes and advances the version.
    ///
    /// # Errors
    /// Returns [`DocumentError`] when the document is unknown, the base version
    /// does not match, or a change range falls outside the current text.
    pub fn apply_changes(
        &mut self,
        uri: &str,
        from_version: DocumentVersion,
        to_version: DocumentVersion,
        changes: &[DocumentContentChange],
    ) -> DocumentResult<()> {
        let state = self.state_mut(uri)?;
        ensure_version(uri, state.version, from_version)?;

        for change in changes {
            apply_single_change(uri, state, change)?;
        }

        state.version = to_version;
        state.rebuild_line_offsets();
        Ok(())
    }

    /// Returns the full text when the requested version matches.
    ///
    /// # Errors
    /// Returns [`DocumentError`] when the document is unknown or the version
    /// does not match.
    pub fn text_at(&self, uri: &str, version: DocumentVersion) -> DocumentResult<&str> {
        let state = self.state(uri)?;
        ensure_version(uri, state.version, version)?;
        Ok(&state.text)
    }

    /// Returns the stored workspace-relative path when the version matches.
    ///
    /// # Errors
    /// Returns [`DocumentError`] when the document is unknown or the version
    /// does not match.
    pub fn file_path_at(
        &self,
        uri: &str,
        version: DocumentVersion,
    ) -> DocumentResult<Option<&str>> {
        let state = self.state(uri)?;
        ensure_version(uri, state.version, version)?;
        Ok(state.file_path.as_deref())
    }

    /// Splits the document into prefix and suffix around the cursor.
    ///
    /// # Errors
    /// Returns [`DocumentError`] when the document is unknown, the version does
    /// not match, or the cursor cannot be resolved to a character boundary.
    pub fn prefix_suffix_at(
        &self,
        uri: &str,
        version: DocumentVersion,
        cursor: Position,
    ) -> DocumentResult<(&str, &str)> {
        let state = self.state(uri)?;
        ensure_version(uri, state.version, version)?;
        split_at_cursor(uri, state, cursor)
    }

    fn state(&self, uri: &str) -> DocumentResult<&DocumentState> {
        self.documents
            .get(uri)
            .ok_or_else(|| DocumentError::MissingDocument {
                uri: uri.to_owned(),
            })
    }

    fn state_mut(&mut self, uri: &str) -> DocumentResult<&mut DocumentState> {
        self.documents
            .get_mut(uri)
            .ok_or_else(|| DocumentError::MissingDocument {
                uri: uri.to_owned(),
            })
    }
}

/// Per-document text plus a cached line-start index for offset resolution.
#[derive(Debug, Clone)]
struct DocumentState {
    version: DocumentVersion,
    file_path: Option<String>,
    text: String,
    line_offsets: Vec<usize>,
}

impl DocumentState {
    fn new(version: DocumentVersion, file_path: Option<String>, text: String) -> Self {
        let mut state = Self {
            version,
            file_path,
            text,
            line_offsets: Vec::new(),
        };
        state.rebuild_line_offsets();
        state
    }

    fn rebuild_line_offsets(&mut self) {
        self.line_offsets.clear();
        self.line_offsets.push(0);

        for (idx, byte) in self.text.bytes().enumerate() {
            if byte == b'\n' {
                self.line_offsets.push(idx + 1);
            }
        }
    }
}

fn ensure_version(
    uri: &str,
    actual: DocumentVersion,
    expected: DocumentVersion,
) -> DocumentResult<()> {
    if actual == expected {
        return Ok(());
    }

    Err(DocumentError::VersionMismatch {
        uri: uri.to_owned(),
        expected,
        actual,
    })
}

fn apply_single_change(
    uri: &str,
    state: &mut DocumentState,
    change: &DocumentContentChange,
) -> DocumentResult<()> {
    let start = offset_for_position(uri, state, position_from_range_start(change.range))?;
    let end = offset_for_position(uri, state, position_from_range_end(change.range))?;

    if !is_valid_replace_span(state, start, end) {
        return Err(DocumentError::InvalidRange {
            uri: uri.to_owned(),
        });
    }

    state.text.replace_range(start..end, &change.inserted_text);
    Ok(())
}

fn split_at_cursor<'a>(
    uri: &str,
    state: &'a DocumentState,
    cursor: Position,
) -> DocumentResult<(&'a str, &'a str)> {
    let offset = offset_for_position(uri, state, cursor)?;

    if offset > state.text.len() || !state.text.is_char_boundary(offset) {
        return Err(DocumentError::InvalidRange {
            uri: uri.to_owned(),
        });
    }

    Ok(state.text.split_at(offset))
}

fn is_valid_replace_span(state: &DocumentState, start: usize, end: usize) -> bool {
    start <= end
        && end <= state.text.len()
        && state.text.is_char_boundary(start)
        && state.text.is_char_boundary(end)
}

fn offset_for_position(
    uri: &str,
    state: &DocumentState,
    position: Position,
) -> DocumentResult<usize> {
    if position.offset > 0 {
        return Ok(byte_offset_from_explicit(position.offset, state));
    }

    let line = usize::try_from(position.line).unwrap_or(0);
    let col = usize::try_from(position.column).unwrap_or(0);
    let Some(line_start) = state.line_offsets.get(line).copied() else {
        return Err(DocumentError::InvalidRange {
            uri: uri.to_owned(),
        });
    };

    Ok((line_start + col).min(state.text.len()))
}

fn byte_offset_from_explicit(offset: u32, state: &DocumentState) -> usize {
    usize::try_from(offset)
        .unwrap_or(usize::MAX)
        .min(state.text.len())
}

fn position_from_range_start(range: Range) -> Position {
    Position {
        line: range.start_line,
        column: range.start_col,
        offset: 0,
    }
}

fn position_from_range_end(range: Range) -> Position {
    Position {
        line: range.end_line,
        column: range.end_col,
        offset: 0,
    }
}
