//! Shared traits and render inputs for FIM and NES model modules.

use core_types::Neighbor;

/// How many tokens a FIM generation should target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GenerationMode {
    /// Single-line completion.
    Line,
    /// A few lines of completion.
    Multiline,
    /// A larger block of completion.
    Block,
}

/// Inputs needed to render a FIM prompt.
#[derive(Debug)]
pub struct FimRenderInput<'a> {
    /// Editor language id.
    pub language_id: &'a str,
    /// Workspace-relative path of the current file.
    pub file_path: &'a str,
    /// Text before the cursor.
    pub prefix: &'a str,
    /// Text after the cursor.
    pub suffix: &'a str,
    /// Retrieved repo neighbors, already ranked and trimmed.
    pub neighbors: &'a [Neighbor],
    /// Target generation size.
    pub generation_mode: GenerationMode,
}

/// Inputs needed to render a NES prompt.
#[derive(Debug)]
pub struct NesRenderInput<'a> {
    /// Editor language id.
    pub language_id: &'a str,
    /// Workspace-relative path of the current file.
    pub file_path: &'a str,
    /// The editable window around the cursor.
    pub current_window: &'a str,
    /// Broader slice of the current file for context.
    pub broad_file_text: &'a str,
    /// Retrieved repo neighbors, already ranked and trimmed.
    pub neighbors: &'a [Neighbor],
}

/// A FIM model module owning one model's prompt format and limits.
pub trait FimModelModule: Send + Sync {
    /// Canonical model id.
    fn model_id(&self) -> &'static str;
    /// Maximum context window in tokens.
    fn context_tokens(&self) -> usize;
    /// Embedder id paired with this model for retrieval.
    fn embedder_id(&self) -> &'static str;
    /// Model-specific special tokens.
    fn special_tokens(&self) -> &'static [&'static str];
    /// Stop tokens passed to the server.
    fn stop_tokens(&self) -> &'static [&'static str];
    /// Output token budget for a generation mode.
    fn max_tokens(&self, mode: GenerationMode) -> u32;
    /// Renders the model's FIM prompt.
    fn render_prompt(&self, input: &FimRenderInput<'_>) -> String;
}

/// A NES model module owning one model's prompt format and parser.
pub trait NesModelModule: Send + Sync {
    /// Canonical model id.
    fn model_id(&self) -> &'static str;
    /// Maximum context window in tokens.
    fn context_tokens(&self) -> usize;
    /// Stop tokens passed to the server.
    fn stop_tokens(&self) -> &'static [&'static str];
    /// Renders the model's NES prompt.
    fn render_prompt(&self, input: &NesRenderInput<'_>) -> String;
    /// Parses raw model output into an updated window, or `None` for no edit.
    fn parse_response(&self, raw: &str) -> Option<String>;
}
