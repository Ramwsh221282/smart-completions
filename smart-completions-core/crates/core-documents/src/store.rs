use std::{borrow::Cow, collections::HashMap};

use core_edit_history::{reconstruct_original_window, slice_line_window, RecentEdit};
use core_types::{DocumentVersion, FileMode, Position, Range};

use crate::{DocumentContentChange, DocumentError, DocumentResult, InitialDocumentSnapshot};

/// Authoritative shadow copy of every synchronized editor document.
#[derive(Debug, Default)]
pub struct CoreDocumentStore {
    documents: HashMap<String, DocumentState>,
}

/// A line-based window around the active cursor inside a synchronized document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentDocumentWindow<'a> {
    /// Borrowed window text without a trailing line break after the last line.
    pub text: &'a str,
    /// Zero-based line where the window starts.
    pub start_line: usize,
    /// Number of logical lines included in the window.
    pub line_count: usize,
    /// UTF-8 byte offset of the cursor inside `text`.
    pub cursor_byte_offset: usize,
}

/// A wider line-based context slice centered around the active cursor line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BroadDocumentWindow<'a> {
    /// Borrowed window text without a trailing line break after the last line.
    pub text: &'a str,
    /// Zero-based line where the window starts.
    pub start_line: usize,
}

/// Line budgets used to build the Sweep current and broad windows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SweepWindowLayout {
    /// How many lines above the cursor to keep in the editable window.
    pub before: u32,
    /// How many lines below the cursor to keep in the editable window.
    pub after: u32,
    /// How many lines to keep in the broader current-file slice.
    pub broad: u32,
}

/// Original-window inputs carried by the request-building layer.
#[derive(Debug, Clone, Copy)]
pub struct SweepOriginalContext<'a, 'b> {
    /// Optional full pre-edit text snapshot from the frontend recorder.
    pub pre_edit_text: Option<&'a str>,
    /// Recent compact diffs used for reconstruction fallback.
    pub recent_edits: &'b [RecentEdit],
}

/// Where the `original/` triad window came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OriginalWindowSource {
    /// Sliced from the explicit pre-edit document snapshot.
    Snapshot,
    /// Reconstructed by reversing the latest intersecting diff hunk.
    Reconstructed,
    /// Fell back to the current window because no pre-edit state was available.
    CurrentFallback,
}

/// Sweep triad snapshot assembled from the synchronized document plus recent edits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SweepDocumentSnapshot<'a> {
    /// The editable current window around the cursor.
    pub current: CurrentDocumentWindow<'a>,
    /// The broader current-file slice for zone-A context.
    pub broad: BroadDocumentWindow<'a>,
    /// The pre-edit window for the `original/` triad block.
    pub original: Cow<'a, str>,
    /// How the `original/` window was obtained.
    pub original_source: OriginalWindowSource,
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
        let state = DocumentState::new(
            snapshot.version,
            snapshot.file_mode,
            snapshot.file_path,
            snapshot.text,
        );
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

    /// Returns the active rewrite window around the cursor.
    ///
    /// Code documents use a fixed before/after line radius. Prose documents
    /// start from the same radius and then expand to the surrounding paragraph
    /// bounded by blank lines.
    ///
    /// # Errors
    /// Returns [`DocumentError`] when the document is unknown, the version does
    /// not match, or the cursor cannot be resolved inside the synchronized text.
    pub fn current_window_at(
        &self,
        uri: &str,
        version: DocumentVersion,
        cursor: Position,
        before_lines: u32,
        after_lines: u32,
    ) -> DocumentResult<CurrentDocumentWindow<'_>> {
        let state = self.state(uri)?;
        ensure_version(uri, state.version, version)?;

        let cursor = resolve_cursor(uri, state, cursor)?;
        let window = current_line_window(uri, state, cursor.line_index, before_lines, after_lines)?;
        let (text, start_offset) = slice_for_line_window(uri, state, window)?;

        Ok(CurrentDocumentWindow {
            text,
            start_line: window.start_line,
            line_count: line_count(window),
            cursor_byte_offset: cursor.byte_offset - start_offset,
        })
    }

    /// Returns a broader, centered line window around the cursor line.
    ///
    /// # Errors
    /// Returns [`DocumentError`] when the document is unknown, the version does
    /// not match, or the cursor cannot be resolved inside the synchronized text.
    pub fn broad_window_at(
        &self,
        uri: &str,
        version: DocumentVersion,
        cursor: Position,
        target_lines: u32,
    ) -> DocumentResult<BroadDocumentWindow<'_>> {
        let state = self.state(uri)?;
        ensure_version(uri, state.version, version)?;

        let cursor = resolve_cursor(uri, state, cursor)?;
        let window = broad_line_window(state, cursor.line_index, target_lines);
        let (text, _) = slice_for_line_window(uri, state, window)?;

        Ok(BroadDocumentWindow {
            text,
            start_line: window.start_line,
        })
    }

    /// Returns the Sweep triad snapshot assembled in Rust.
    ///
    /// The current and broad windows come from the synchronized document store.
    /// The original window prefers a provided pre-edit snapshot, then falls back
    /// to diff-based reconstruction, then finally to the current window.
    ///
    /// # Errors
    /// Returns [`DocumentError`] when the document is unknown, the version does
    /// not match, or the cursor cannot be resolved inside the synchronized text.
    pub fn sweep_snapshot_at<'a>(
        &'a self,
        uri: &str,
        version: DocumentVersion,
        cursor: Position,
        layout: SweepWindowLayout,
        original_context: SweepOriginalContext<'a, '_>,
    ) -> DocumentResult<SweepDocumentSnapshot<'a>> {
        let current = self.current_window_at(uri, version, cursor, layout.before, layout.after)?;
        let broad = self.broad_window_at(uri, version, cursor, layout.broad)?;
        let (original, original_source) = original_window_for_snapshot(
            uri,
            original_context.pre_edit_text,
            original_context.recent_edits,
            &current,
        );

        Ok(SweepDocumentSnapshot {
            current,
            broad,
            original,
            original_source,
        })
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
    file_mode: FileMode,
    file_path: Option<String>,
    text: String,
    line_offsets: Vec<usize>,
}

impl DocumentState {
    fn new(
        version: DocumentVersion,
        file_mode: FileMode,
        file_path: Option<String>,
        text: String,
    ) -> Self {
        let mut state = Self {
            version,
            file_mode,
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
    let span = resolve_change_span(uri, state, change)?;

    if !is_valid_replace_span(state, span.start, span.end) {
        return Err(invalid_range(uri));
    }

    state
        .text
        .replace_range(span.start..span.end, &change.inserted_text);
    Ok(())
}

fn split_at_cursor<'a>(
    uri: &str,
    state: &'a DocumentState,
    cursor: Position,
) -> DocumentResult<(&'a str, &'a str)> {
    let offset = byte_offset_for_position(uri, state, cursor)?;

    if offset > state.text.len() || !state.text.is_char_boundary(offset) {
        return Err(invalid_range(uri));
    }

    Ok(state.text.split_at(offset))
}

fn is_valid_replace_span(state: &DocumentState, start: usize, end: usize) -> bool {
    start <= end
        && end <= state.text.len()
        && state.text.is_char_boundary(start)
        && state.text.is_char_boundary(end)
}

fn resolve_cursor(
    uri: &str,
    state: &DocumentState,
    cursor: Position,
) -> DocumentResult<ResolvedCursor> {
    let byte_offset = byte_offset_for_position(uri, state, cursor)?;
    let line_index = line_index_for_byte_offset(state, byte_offset);

    Ok(ResolvedCursor {
        byte_offset,
        line_index,
    })
}

fn current_line_window(
    uri: &str,
    state: &DocumentState,
    cursor_line: usize,
    before_lines: u32,
    after_lines: u32,
) -> DocumentResult<LineWindow> {
    match state.file_mode {
        FileMode::Code => Ok(fixed_line_window(
            state,
            cursor_line,
            before_lines,
            after_lines,
        )),
        FileMode::Prose => prose_line_window(uri, state, cursor_line, before_lines, after_lines),
    }
}

fn broad_line_window(state: &DocumentState, cursor_line: usize, target_lines: u32) -> LineWindow {
    let safe_lines = usize::try_from(target_lines).unwrap_or(1).max(1);
    let before_lines = (safe_lines - 1) / 2;
    let start_line = cursor_line.saturating_sub(before_lines);
    let end_line = start_line
        .saturating_add(safe_lines - 1)
        .min(last_line_index(state));

    LineWindow {
        start_line,
        end_line,
    }
}

fn fixed_line_window(
    state: &DocumentState,
    cursor_line: usize,
    before_lines: u32,
    after_lines: u32,
) -> LineWindow {
    let before_lines = usize::try_from(before_lines).unwrap_or(usize::MAX);
    let after_lines = usize::try_from(after_lines).unwrap_or(usize::MAX);
    let start_line = cursor_line.saturating_sub(before_lines);
    let end_line = cursor_line
        .saturating_add(after_lines)
        .min(last_line_index(state));

    LineWindow {
        start_line,
        end_line,
    }
}

fn prose_line_window(
    uri: &str,
    state: &DocumentState,
    cursor_line: usize,
    before_lines: u32,
    after_lines: u32,
) -> DocumentResult<LineWindow> {
    let mut window = fixed_line_window(state, cursor_line, before_lines, after_lines);

    while window.start_line > 0 && !is_blank_line(uri, state, window.start_line - 1)? {
        window.start_line -= 1;
    }
    while window.end_line < last_line_index(state)
        && !is_blank_line(uri, state, window.end_line + 1)?
    {
        window.end_line += 1;
    }

    Ok(window)
}

fn slice_for_line_window<'a>(
    uri: &str,
    state: &'a DocumentState,
    window: LineWindow,
) -> DocumentResult<(&'a str, usize)> {
    let (start_offset, _) = line_content_bounds(uri, state, window.start_line)?;
    let (_, end_offset) = line_content_bounds(uri, state, window.end_line)?;

    Ok((&state.text[start_offset..end_offset], start_offset))
}

fn original_window_for_snapshot<'a>(
    uri: &str,
    pre_edit_text: Option<&'a str>,
    recent_edits: &[RecentEdit],
    current: &CurrentDocumentWindow<'a>,
) -> (Cow<'a, str>, OriginalWindowSource) {
    if let Some(text) = pre_edit_text {
        return (
            Cow::Owned(slice_line_window(
                text,
                current.start_line,
                current.line_count,
            )),
            OriginalWindowSource::Snapshot,
        );
    }

    if let Some(text) =
        reconstruct_original_window(current.text, current.start_line, uri, recent_edits)
    {
        return (Cow::Owned(text), OriginalWindowSource::Reconstructed);
    }

    (
        Cow::Borrowed(current.text),
        OriginalWindowSource::CurrentFallback,
    )
}

fn is_blank_line(uri: &str, state: &DocumentState, line: usize) -> DocumentResult<bool> {
    let (start, end) = line_content_bounds(uri, state, line)?;
    Ok(state.text[start..end].trim().is_empty())
}

fn line_index_for_byte_offset(state: &DocumentState, byte_offset: usize) -> usize {
    state
        .line_offsets
        .partition_point(|line_start| *line_start <= byte_offset)
        .saturating_sub(1)
}

fn last_line_index(state: &DocumentState) -> usize {
    state.line_offsets.len().saturating_sub(1)
}

fn line_count(window: LineWindow) -> usize {
    window.end_line - window.start_line + 1
}

fn byte_offset_for_position(
    uri: &str,
    state: &DocumentState,
    position: Position,
) -> DocumentResult<usize> {
    if position.offset > 0 {
        return byte_offset_for_utf16_units(uri, &state.text, position.offset);
    }

    let line = usize::try_from(position.line).map_err(|_| invalid_range(uri))?;
    let column = u32::try_from(position.column).map_err(|_| invalid_range(uri))?;
    let (line_start, line_end) = line_content_bounds(uri, state, line)?;
    let column_offset =
        byte_offset_for_utf16_units(uri, &state.text[line_start..line_end], column)?;

    Ok(line_start + column_offset)
}

fn resolve_change_span(
    uri: &str,
    state: &DocumentState,
    change: &DocumentContentChange,
) -> DocumentResult<ReplaceSpan> {
    let start = byte_offset_for_position(uri, state, position_from_range_start(change.range))?;
    let end = byte_offset_for_position(uri, state, position_from_range_end(change.range))?;

    if start > end {
        return Err(invalid_range(uri));
    }

    if utf16_units(&state.text[start..end]) != change.range_length {
        return Err(invalid_range(uri));
    }

    Ok(ReplaceSpan { start, end })
}

fn line_content_bounds(
    uri: &str,
    state: &DocumentState,
    line: usize,
) -> DocumentResult<(usize, usize)> {
    let Some(line_start) = state.line_offsets.get(line).copied() else {
        return Err(invalid_range(uri));
    };

    let mut line_end = state
        .line_offsets
        .get(line + 1)
        .copied()
        .map_or(state.text.len(), |next_line_start| {
            next_line_start.saturating_sub(1)
        });

    if line_end > line_start && state.text.as_bytes()[line_end - 1] == b'\r' {
        line_end -= 1;
    }

    Ok((line_start, line_end))
}

fn byte_offset_for_utf16_units(uri: &str, text: &str, target_units: u32) -> DocumentResult<usize> {
    if target_units == 0 {
        return Ok(0);
    }

    let mut units = 0_u32;
    for (byte_idx, ch) in text.char_indices() {
        if units == target_units {
            return Ok(byte_idx);
        }

        units = units.saturating_add(u32::try_from(ch.len_utf16()).unwrap_or(0));
        if units == target_units {
            return Ok(byte_idx + ch.len_utf8());
        }
        if units > target_units {
            return Err(invalid_range(uri));
        }
    }

    if units == target_units {
        return Ok(text.len());
    }

    Err(invalid_range(uri))
}

fn utf16_units(text: &str) -> u32 {
    text.chars()
        .map(|ch| u32::try_from(ch.len_utf16()).unwrap_or(0))
        .sum()
}

fn invalid_range(uri: &str) -> DocumentError {
    DocumentError::InvalidRange {
        uri: uri.to_owned(),
    }
}

#[derive(Debug, Clone, Copy)]
struct ResolvedCursor {
    byte_offset: usize,
    line_index: usize,
}

#[derive(Debug, Clone, Copy)]
struct LineWindow {
    start_line: usize,
    end_line: usize,
}

#[derive(Debug, Clone, Copy)]
struct ReplaceSpan {
    start: usize,
    end: usize,
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
