//! Qwen2.5 Coder FIM module.

use std::fmt::Write;

use crate::traits::{FimModelModule, FimRenderInput, GenerationMode};

const STOP_TOKENS: &[&str] = &[
    "<|fim_pad|>",
    "<|endoftext|>",
    "<|file_sep|>",
    "<|repo_name|>",
];
const SPECIAL_TOKENS: &[&str] = &[];

/// Qwen2.5 Coder FIM model module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Qwen25Module;

impl FimModelModule for Qwen25Module {
    fn model_id(&self) -> &'static str {
        "qwen2.5-coder"
    }

    fn context_tokens(&self) -> usize {
        32_768
    }

    fn embedder_id(&self) -> &'static str {
        "jina-code"
    }

    fn special_tokens(&self) -> &'static [&'static str] {
        SPECIAL_TOKENS
    }

    fn stop_tokens(&self) -> &'static [&'static str] {
        STOP_TOKENS
    }

    fn max_tokens(&self, mode: GenerationMode) -> u32 {
        match mode {
            GenerationMode::Line => 48,
            GenerationMode::Multiline => 160,
            GenerationMode::Block => 384,
        }
    }

    fn render_prompt(&self, input: &FimRenderInput<'_>) -> String {
        let mut out = String::with_capacity(estimate_prompt_capacity(input));

        append_repo_context(&mut out, input);
        append_current_file_fim(&mut out, input);

        out
    }
}

fn estimate_prompt_capacity(input: &FimRenderInput<'_>) -> usize {
    input.prefix.len()
        + input.suffix.len()
        + input
            .neighbors
            .iter()
            .map(|n| n.text.len() + n.file_path.len() + 32)
            .sum::<usize>()
        + 256
}

fn append_repo_context(out: &mut String, input: &FimRenderInput<'_>) {
    if input.neighbors.is_empty() {
        return;
    }

    let _ = writeln!(out, "<|repo_name|>workspace");

    for neighbor in input.neighbors {
        append_neighbor(out, &neighbor.file_path, &neighbor.text);
    }
}

fn append_neighbor(out: &mut String, file_path: &str, text: &str) {
    let _ = writeln!(out, "<|file_sep|>{file_path}");
    let _ = writeln!(out, "{text}");
}

fn append_current_file_fim(out: &mut String, input: &FimRenderInput<'_>) {
    let _ = write!(
        out,
        "<|file_sep|>{}<|fim_prefix|>{}<|fim_suffix|>{}<|fim_middle|>",
        input.file_path, input.prefix, input.suffix
    );
}
