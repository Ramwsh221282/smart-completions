//! Sweep NES module.
//!
//! This phase renders the file-separated block skeleton and parses the raw
//! response. The full original/current/updated triad with cursor and prefill
//! arrives once the trimmer, signals and edit-history crates land.

use std::fmt::Write;

use crate::traits::{NesModelModule, NesRenderInput};

const STOP_TOKENS: &[&str] = &["<|file_sep|>", "<|endoftext|>"];
const NO_EDITS_SENTINEL: &str = "NO_EDITS";

/// Sweep next-edit-suggestion model module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SweepModule;

impl NesModelModule for SweepModule {
    fn model_id(&self) -> &'static str {
        "sweep"
    }

    fn context_tokens(&self) -> usize {
        32_768
    }

    fn stop_tokens(&self) -> &'static [&'static str] {
        STOP_TOKENS
    }

    fn render_prompt(&self, input: &NesRenderInput<'_>) -> String {
        let mut out = String::with_capacity(estimate_prompt_capacity(input));

        append_broad_file(&mut out, input);
        append_neighbors(&mut out, input);
        append_current_window(&mut out, input);

        out
    }

    fn parse_response(&self, raw: &str) -> Option<String> {
        let cleaned = clean_response(raw);
        if cleaned.is_empty() || cleaned == NO_EDITS_SENTINEL {
            return None;
        }

        Some(cleaned)
    }
}

fn estimate_prompt_capacity(input: &NesRenderInput<'_>) -> usize {
    input.broad_file_text.len()
        + input.current_window.len()
        + input
            .neighbors
            .iter()
            .map(|n| n.text.len() + n.file_path.len() + 32)
            .sum::<usize>()
        + 256
}

fn append_broad_file(out: &mut String, input: &NesRenderInput<'_>) {
    if input.broad_file_text.is_empty() {
        return;
    }

    let _ = writeln!(out, "<|file_sep|>{}", input.file_path);
    let _ = writeln!(out, "{}", input.broad_file_text);
}

fn append_neighbors(out: &mut String, input: &NesRenderInput<'_>) {
    for neighbor in input.neighbors {
        let _ = writeln!(out, "<|file_sep|>{}", neighbor.file_path);
        let _ = writeln!(out, "{}", neighbor.text);
    }
}

fn append_current_window(out: &mut String, input: &NesRenderInput<'_>) {
    let _ = write!(
        out,
        "<|file_sep|>current/{}\n{}",
        input.file_path, input.current_window
    );
}

fn clean_response(raw: &str) -> String {
    let without_cursor = raw.replace("<|cursor|>", "");
    cut_at_stop(&without_cursor).trim().to_owned()
}

fn cut_at_stop(text: &str) -> &str {
    let mut end = text.len();

    for stop in STOP_TOKENS {
        if let Some(idx) = text.find(stop) {
            end = end.min(idx);
        }
    }

    &text[..end]
}
