//! Spawns and runs streamed FIM/NES completions.

use core_ipc::ServerFrame;
use core_llama::{GenerationClient, GenerationRequest, LlamaError, LlamaResult};
use core_types::{Position, Range};
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

const SWEEP_MARKERS: [&str; 2] = ["<|cursor|>", "<|file_sep|>"];
const NO_EDITS_SENTINEL: &str = "NO_EDITS";

/// Owned inputs for one streamed FIM completion task.
pub(crate) struct FimCompletion {
    /// Generation client targeting the FIM llama-server.
    pub client: GenerationClient,
    /// Rendered prompt.
    pub prompt: String,
    /// Output token budget.
    pub max_tokens: u32,
    /// Model stop tokens.
    pub stop: &'static [&'static str],
    /// Cancellation token for this request.
    pub cancel: CancellationToken,
    /// Channel that carries server frames back to the connection.
    pub out: UnboundedSender<ServerFrame>,
    /// Request id for frame correlation.
    pub request_id: u64,
}

/// Owned inputs for one NES completion task that resolves to an edit.
pub(crate) struct NesCompletion {
    /// Generation client targeting the NES llama-server.
    pub client: GenerationClient,
    /// Rendered prompt.
    pub prompt: String,
    /// Output token budget.
    pub max_tokens: u32,
    /// Model stop tokens.
    pub stop: &'static [&'static str],
    /// Cancellation token for this request.
    pub cancel: CancellationToken,
    /// Channel that carries server frames back to the connection.
    pub out: UnboundedSender<ServerFrame>,
    /// Request id for frame correlation.
    pub request_id: u64,
    /// Current editable window before applying the model output.
    pub current_window_text: String,
    /// Zero-based line where the editable window starts.
    pub window_start_line: usize,
    /// Cursor byte offset inside `current_window_text`.
    pub cursor_byte_offset: usize,
}

/// Spawns a detached task that streams the completion into the frame channel.
pub(crate) fn spawn_fim_completion(params: FimCompletion) {
    tokio::spawn(run_fim_completion(params));
}

/// Spawns a detached task that resolves a NES request into one edit frame.
pub(crate) fn spawn_nes_completion(params: NesCompletion) {
    tokio::spawn(run_nes_completion(params));
}

async fn run_fim_completion(params: FimCompletion) {
    let request = generation_request(&params.prompt, params.max_tokens, params.stop);

    let out = params.out.clone();
    let request_id = params.request_id;
    let result = params
        .client
        .stream_completion(&request, &params.cancel, |text| {
            emit_token(&out, request_id, text)
        })
        .await;

    finish(&params.out, request_id, result);
}

async fn run_nes_completion(params: NesCompletion) {
    let request = generation_request(&params.prompt, params.max_tokens, params.stop);
    let mut raw = String::new();
    let request_id = params.request_id;
    let result = params
        .client
        .stream_completion(&request, &params.cancel, |text| {
            raw.push_str(&text);
            Ok(())
        })
        .await;

    finish_nes(&params, request_id, result, &raw);
}

fn generation_request<'a>(
    prompt: &'a str,
    max_tokens: u32,
    stop: &'a [&'a str],
) -> GenerationRequest<'a> {
    GenerationRequest {
        prompt,
        max_tokens,
        temperature: 0.0,
        stream: true,
        cache_prompt: true,
        stop,
    }
}

fn emit_token(
    out: &UnboundedSender<ServerFrame>,
    request_id: u64,
    text: String,
) -> LlamaResult<()> {
    out.send(ServerFrame::Token { request_id, text })
        .map_err(|err| LlamaError::Callback(err.to_string()))
}

fn finish(out: &UnboundedSender<ServerFrame>, request_id: u64, result: LlamaResult<()>) {
    let frame = match result {
        Ok(()) => ServerFrame::Done { request_id },
        Err(err) => ServerFrame::Error {
            request_id,
            message: err.to_string(),
        },
    };
    let _ = out.send(frame);
}

fn finish_nes(params: &NesCompletion, request_id: u64, result: LlamaResult<()>, raw: &str) {
    match result {
        Ok(()) => {
            if !params.cancel.is_cancelled() {
                emit_nes_edit(params, request_id, raw);
            }
            let _ = params.out.send(ServerFrame::Done { request_id });
        }
        Err(err) => {
            let _ = params.out.send(ServerFrame::Error {
                request_id,
                message: err.to_string(),
            });
        }
    }
}

fn emit_nes_edit(params: &NesCompletion, request_id: u64, raw: &str) {
    let Some(parsed) = parse_sweep_edit(
        raw,
        &params.current_window_text,
        params.window_start_line,
        params.cursor_byte_offset,
        params.stop,
    ) else {
        return;
    };

    let _ = params.out.send(ServerFrame::Edit {
        request_id,
        range: parsed.range,
        new_text: parsed.new_text,
        jump: Some(parsed.range.start_position()),
    });
}

struct ParsedEdit {
    range: Range,
    new_text: String,
}

fn parse_sweep_edit(
    raw: &str,
    old_window_text: &str,
    window_start_line: usize,
    cursor_byte_offset: usize,
    stop_tokens: &[&str],
) -> Option<ParsedEdit> {
    let updated_window = clean_sweep_response(raw, stop_tokens);
    if updated_window.is_empty() || updated_window.trim() == NO_EDITS_SENTINEL {
        return None;
    }

    let old_window = normalize_crlf(old_window_text);
    let edit = diff_windows(&old_window, &updated_window, window_start_line)?;
    if sweep_reject_reason(
        &old_window,
        &updated_window,
        window_start_line,
        cursor_byte_offset,
        &edit,
    )
    .is_some()
    {
        return None;
    }
    Some(edit)
}

fn clean_sweep_response(raw: &str, stop_tokens: &[&str]) -> String {
    let mut text = normalize_crlf(raw).trim_end().to_owned();
    for marker in SWEEP_MARKERS {
        text = text.replace(marker, "");
    }
    for stop in stop_tokens {
        if let Some(index) = text.find(stop) {
            text.truncate(index);
        }
    }
    text.trim_end().to_owned()
}

fn diff_windows(old_text: &str, new_text: &str, window_start_line: usize) -> Option<ParsedEdit> {
    let old_lines: Vec<&str> = old_text.split('\n').collect();
    let new_lines: Vec<&str> = new_text.split('\n').collect();
    let old_len = old_lines.len();
    let new_len = new_lines.len();

    let mut prefix = 0usize;
    while prefix < old_len && prefix < new_len && old_lines[prefix] == new_lines[prefix] {
        prefix += 1;
    }

    let mut suffix = 0usize;
    while suffix < old_len.saturating_sub(prefix)
        && suffix < new_len.saturating_sub(prefix)
        && old_lines[old_len - 1 - suffix] == new_lines[new_len - 1 - suffix]
    {
        suffix += 1;
    }

    if prefix == old_len && prefix == new_len {
        return None;
    }

    let old_end = old_len - suffix;
    let new_end = new_len - suffix;
    let replace_text = join_line_range(&new_lines, prefix, new_end);
    let replace_count = new_end.saturating_sub(prefix);
    let ends_before_retained_line = old_end < old_len;

    Some(ParsedEdit {
        range: Range {
            start_line: i32::try_from(window_start_line + prefix).unwrap_or(i32::MAX),
            start_col: 0,
            end_line: end_line(window_start_line, old_lines.len(), old_end),
            end_col: end_col(&old_lines, old_end),
        },
        new_text: if ends_before_retained_line && replace_count > 0 {
            format!("{replace_text}\n")
        } else {
            replace_text
        },
    })
}

fn join_line_range(lines: &[&str], start: usize, end_exclusive: usize) -> String {
    if start >= end_exclusive {
        return String::new();
    }
    let mut out = String::from(lines[start]);
    for line in &lines[start + 1..end_exclusive] {
        out.push('\n');
        out.push_str(line);
    }
    out
}

fn end_line(window_start_line: usize, old_len: usize, old_end: usize) -> i32 {
    if old_end < old_len {
        i32::try_from(window_start_line + old_end).unwrap_or(i32::MAX)
    } else {
        i32::try_from(window_start_line + old_len.saturating_sub(1)).unwrap_or(i32::MAX)
    }
}

fn end_col(old_lines: &[&str], old_end: usize) -> i32 {
    if old_end < old_lines.len() {
        0
    } else {
        utf16_len(old_lines.last().copied().unwrap_or(""))
    }
}

fn sweep_reject_reason(
    old_window_text: &str,
    updated_window_text: &str,
    window_start_line: usize,
    cursor_offset: usize,
    edit: &ParsedEdit,
) -> Option<&'static str> {
    if same_without_whitespace(old_window_text, updated_window_text) {
        return Some("whitespace-only");
    }

    let old_line_count = count_lines(old_window_text);
    let new_line_count = count_lines(updated_window_text);
    if window_shape_rejected(old_line_count, new_line_count) {
        return Some("window-shape");
    }
    if pure_insertion_above_cursor(edit, window_start_line, old_window_text, cursor_offset) {
        return Some("pure-insertion-above-cursor");
    }
    if edit_volume_rejected(edit, old_line_count) {
        return Some("edit-volume");
    }
    None
}

fn same_without_whitespace(old_text: &str, new_text: &str) -> bool {
    old_text != new_text && strip_whitespace(old_text) == strip_whitespace(new_text)
}

fn strip_whitespace(text: &str) -> String {
    text.chars().filter(|ch| !ch.is_whitespace()).collect()
}

fn window_shape_rejected(old_line_count: usize, new_line_count: usize) -> bool {
    let max_growth = old_line_count.max(8);
    let min_lines = (old_line_count / 4).max(1);
    new_line_count > old_line_count + max_growth || new_line_count < min_lines
}

fn pure_insertion_above_cursor(
    edit: &ParsedEdit,
    window_start_line: usize,
    old_text: &str,
    cursor_offset: usize,
) -> bool {
    if edit.range.start_line != edit.range.end_line || edit.range.start_col != edit.range.end_col {
        return false;
    }
    if edit.new_text.is_empty() || count_lines(&edit.new_text) <= 1 {
        return false;
    }
    let cursor_line = window_start_line + line_index_at_offset(old_text, cursor_offset);
    usize::try_from(edit.range.start_line).unwrap_or(usize::MAX) < cursor_line
        && usize::try_from(edit.range.end_line).unwrap_or(usize::MAX) <= cursor_line
}

fn edit_volume_rejected(edit: &ParsedEdit, old_line_count: usize) -> bool {
    let removed_lines =
        usize::try_from((edit.range.end_line - edit.range.start_line).max(0)).unwrap_or(usize::MAX);
    let inserted_lines = count_lines(&edit.new_text);
    let touched_lines = removed_lines.max(inserted_lines);
    let limit = 12usize.max((old_line_count * 3).div_ceil(4));
    touched_lines > limit
}

fn count_lines(text: &str) -> usize {
    if text.is_empty() {
        1
    } else {
        text.split('\n').count()
    }
}

fn line_index_at_offset(text: &str, offset: usize) -> usize {
    let safe_offset = offset.min(text.len());
    text[..safe_offset]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count()
}

fn normalize_crlf(text: &str) -> String {
    text.replace("\r\n", "\n")
}

fn utf16_len(text: &str) -> i32 {
    text.chars()
        .map(|ch| i32::try_from(ch.len_utf16()).unwrap_or(0))
        .sum()
}

trait RangeStartPosition {
    fn start_position(&self) -> Position;
}

impl RangeStartPosition for Range {
    fn start_position(&self) -> Position {
        Position {
            line: self.start_line,
            column: self.start_col,
            offset: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_sweep_edit;

    #[test]
    fn parse_sweep_edit_rejects_whitespace_only_updates() {
        let parsed = parse_sweep_edit(
            "const  x = 1;",
            "const x = 1;",
            0,
            0,
            &["<|file_sep|>", "<|endoftext|>"],
        );

        assert!(parsed.is_none());
    }

    #[test]
    fn parse_sweep_edit_builds_a_minimal_replacement() {
        let parsed = parse_sweep_edit(
            "const x = 2;",
            "const x = 1;\n",
            4,
            10,
            &["<|file_sep|>", "<|endoftext|>"],
        )
        .unwrap();

        assert_eq!(parsed.range.start_line, 4);
        assert_eq!(parsed.range.end_line, 5);
        assert_eq!(parsed.new_text, "const x = 2;");
    }
}
