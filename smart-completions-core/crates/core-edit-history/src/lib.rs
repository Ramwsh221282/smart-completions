//! Edit-history helpers for Rust-side NES/FIM request building.
//!
//! The TypeScript baseline stores compact unified diffs plus an optional
//! document snapshot before the last edit. This crate ports the compact diff
//! builder, line-window slicing, and fallback original-window reconstruction so
//! the Rust core can own that logic incrementally.

use std::{borrow::Cow, fmt::Write};

/// One recent edit emitted by the frontend and later owned by the Rust core.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentEdit {
    /// URI of the edited document.
    pub uri: String,
    /// Compact unified diff for the edit.
    pub unified_diff: String,
    /// Millisecond timestamp used to keep edits in chronological order.
    pub timestamp: u64,
}

/// Returns a normalized LF-only line window from a full-text snapshot.
#[must_use]
pub fn slice_line_window(text: &str, start_line0: usize, line_count: usize) -> String {
    if line_count == 0 {
        return String::new();
    }

    let lines = split_lines(text);
    join_line_range(&lines, start_line0, start_line0.saturating_add(line_count))
}

/// Builds the compact unified diff format used by the current TS edit history.
#[must_use]
pub fn format_sweep_unified_diff(uri: &str, before: &str, after: &str) -> String {
    let old_lines = split_lines(before);
    let new_lines = split_lines(after);
    let prefix = shared_prefix_len(&old_lines, &new_lines);
    let suffix = shared_suffix_len(&old_lines, &new_lines, prefix);

    if prefix == old_lines.len() && prefix == new_lines.len() {
        return String::new();
    }

    let old_end = old_lines.len() - suffix;
    let new_end = new_lines.len() - suffix;
    let mut diff = String::new();

    write_header(&mut diff, uri, prefix, old_end, new_end);
    write_removed_lines(&mut diff, &old_lines, prefix, old_end);
    write_added_lines(&mut diff, &new_lines, prefix, new_end);

    diff
}

/// Reconstructs the pre-edit window by reversing the latest intersecting hunk.
#[must_use]
pub fn reconstruct_original_window(
    current_window_text: &str,
    window_start_line0: usize,
    uri: &str,
    recent_edits: &[RecentEdit],
) -> Option<String> {
    let current_lines = split_lines(current_window_text);
    let window_end_exclusive = window_start_line0 + current_lines.len();

    for edit in recent_edits.iter().rev() {
        if edit.uri != uri {
            continue;
        }

        let hunks = parse_unified_diff_hunks(&edit.unified_diff);
        for hunk in hunks.iter().rev() {
            if !hunk_overlaps_window(hunk, window_start_line0, window_end_exclusive) {
                continue;
            }

            let Some(reconstructed) = reverse_apply_hunk(&current_lines, window_start_line0, hunk)
            else {
                continue;
            };
            if reconstructed != normalize_crlf(current_window_text).as_ref() {
                return Some(reconstructed);
            }
        }
    }

    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedHunk {
    old_start_line0: usize,
    old_line_count: usize,
    new_start_line0: usize,
    new_line_count: usize,
    original_lines: Vec<String>,
    updated_lines: Vec<String>,
}

fn split_lines(text: &str) -> Vec<String> {
    normalize_crlf(text)
        .split('\n')
        .map(ToOwned::to_owned)
        .collect()
}

fn normalize_crlf(text: &str) -> Cow<'_, str> {
    if !text.contains('\r') {
        return Cow::Borrowed(text);
    }

    Cow::Owned(text.replace("\r\n", "\n").replace('\r', "\n"))
}

fn join_line_range(lines: &[String], start: usize, end_exclusive: usize) -> String {
    let end = end_exclusive.min(lines.len());
    if start >= end {
        return String::new();
    }

    let mut out = String::new();
    for line in &lines[start..end] {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(line);
    }
    out
}

fn shared_prefix_len(old_lines: &[String], new_lines: &[String]) -> usize {
    let mut prefix = 0;
    while prefix < old_lines.len()
        && prefix < new_lines.len()
        && old_lines[prefix] == new_lines[prefix]
    {
        prefix += 1;
    }
    prefix
}

fn shared_suffix_len(old_lines: &[String], new_lines: &[String], prefix: usize) -> usize {
    let mut suffix = 0;
    while suffix < old_lines.len().saturating_sub(prefix)
        && suffix < new_lines.len().saturating_sub(prefix)
        && old_lines[old_lines.len() - 1 - suffix] == new_lines[new_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }
    suffix
}

fn write_header(diff: &mut String, uri: &str, prefix: usize, old_end: usize, new_end: usize) {
    let _ = writeln!(diff, "--- {uri}");
    let _ = writeln!(diff, "+++ {uri}");
    let _ = writeln!(
        diff,
        "@@ -{},{} +{},{} @@",
        prefix + 1,
        old_end - prefix,
        prefix + 1,
        new_end - prefix
    );
}

fn write_removed_lines(diff: &mut String, old_lines: &[String], prefix: usize, old_end: usize) {
    for line in &old_lines[prefix..old_end] {
        let _ = writeln!(diff, "-{line}");
    }
}

fn write_added_lines(diff: &mut String, new_lines: &[String], prefix: usize, new_end: usize) {
    for (index, line) in new_lines[prefix..new_end].iter().enumerate() {
        diff.push('+');
        diff.push_str(line);
        if index + prefix + 1 < new_end {
            diff.push('\n');
        }
    }
}

fn parse_unified_diff_hunks(diff: &str) -> Vec<ParsedHunk> {
    let lines = split_lines(diff);
    let mut hunks = Vec::new();
    let mut current_index: Option<usize> = None;

    for line in lines {
        if let Some(hunk) = parse_hunk_header(&line) {
            hunks.push(hunk);
            current_index = Some(hunks.len() - 1);
            continue;
        }

        let Some(index) = current_index else {
            continue;
        };
        if should_skip_diff_metadata(&line) {
            continue;
        }

        append_diff_line(&mut hunks[index], &line);
    }

    hunks
}

fn parse_hunk_header(line: &str) -> Option<ParsedHunk> {
    if !line.starts_with("@@ -") || !line.ends_with(" @@") {
        return None;
    }

    let body = &line[3..line.len() - 3];
    let mut parts = body.split_whitespace();
    let old = parts.next()?;
    let new = parts.next()?;

    let (old_start_line0, old_line_count) = parse_hunk_range(old.strip_prefix('-')?)?;
    let (new_start_line0, new_line_count) = parse_hunk_range(new.strip_prefix('+')?)?;

    Some(ParsedHunk {
        old_start_line0,
        old_line_count,
        new_start_line0,
        new_line_count,
        original_lines: Vec::new(),
        updated_lines: Vec::new(),
    })
}

fn parse_hunk_range(raw: &str) -> Option<(usize, usize)> {
    let (line, count) = raw
        .split_once(',')
        .map_or((raw, None), |(line, count)| (line, Some(count)));
    let start = line.parse::<usize>().ok()?.checked_sub(1)?;
    let line_count = count.map_or(Some(1), |value| value.parse::<usize>().ok())?;
    Some((start, line_count))
}

fn should_skip_diff_metadata(line: &str) -> bool {
    line.starts_with("--- ")
        || line.starts_with("+++ ")
        || line.starts_with("Index: ")
        || line.starts_with("===")
}

fn append_diff_line(hunk: &mut ParsedHunk, line: &str) {
    if let Some(text) = line.strip_prefix('-') {
        hunk.original_lines.push(text.to_owned());
        return;
    }
    if let Some(text) = line.strip_prefix('+') {
        hunk.updated_lines.push(text.to_owned());
        return;
    }
    if let Some(text) = line.strip_prefix(' ') {
        let text = text.to_owned();
        hunk.original_lines.push(text.clone());
        hunk.updated_lines.push(text);
        return;
    }

    hunk.original_lines.push(line.to_owned());
    hunk.updated_lines.push(line.to_owned());
}

fn hunk_overlaps_window(
    hunk: &ParsedHunk,
    window_start_line0: usize,
    window_end_exclusive: usize,
) -> bool {
    let hunk_start = hunk.new_start_line0;
    let hunk_end = hunk.new_start_line0 + hunk.new_line_count;

    if hunk.new_line_count == 0 {
        return hunk_start >= window_start_line0 && hunk_start <= window_end_exclusive;
    }

    hunk_start < window_end_exclusive && hunk_end > window_start_line0
}

fn reverse_apply_hunk(
    current_lines: &[String],
    window_start_line0: usize,
    hunk: &ParsedHunk,
) -> Option<String> {
    let offset = hunk.new_start_line0.checked_sub(window_start_line0)?;
    if offset > current_lines.len() || offset + hunk.new_line_count > current_lines.len() {
        return None;
    }
    if !updated_lines_match(current_lines, offset, hunk) {
        return None;
    }

    let mut reconstructed =
        Vec::with_capacity(current_lines.len() - hunk.new_line_count + hunk.old_line_count);
    reconstructed.extend_from_slice(&current_lines[..offset]);
    reconstructed.extend(hunk.original_lines.iter().cloned());
    reconstructed.extend_from_slice(&current_lines[offset + hunk.new_line_count..]);

    Some(join_line_range(&reconstructed, 0, reconstructed.len()))
}

fn updated_lines_match(current_lines: &[String], offset: usize, hunk: &ParsedHunk) -> bool {
    hunk.updated_lines
        .iter()
        .enumerate()
        .all(|(index, line)| current_lines[offset + index] == *line)
}
