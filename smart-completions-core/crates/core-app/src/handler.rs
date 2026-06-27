//! Client-frame handler: document sync plus the FIM pilot route.

use std::fmt::Write;
use std::path::{Path, PathBuf};

use core_dispatch::CancellationRegistry;
use core_documents::{CoreDocumentStore, DocumentContentChange, InitialDocumentSnapshot};
use core_ipc::{
    ClientFrame, ServerFrame, WireCompletionRequest, WireDiagnostic, WireDiagnosticSeverity,
    WireDocumentChange, WireInitialDocument, WireOutlineItem, WireRelatedFileHint, WireTextChange,
};
use core_llama::GenerationClient;
use core_models::{FimModelModule, FimModuleKind, FimRenderInput, GenerationMode};
use core_types::{CompletionMode, Neighbor, Range};
use tokio::sync::mpsc::UnboundedSender;

use crate::completion::{spawn_fim_completion, FimCompletion};

const MAX_RELATED_HINT_NEIGHBORS: usize = 6;

/// What the connection loop should do after one frame.
pub enum HandleOutcome {
    /// Keep serving the connection.
    Continue,
    /// Stop serving and shut the core down.
    Shutdown,
}

/// Applies client frames to the shadow store and routes FIM completions.
pub struct CoreFrameHandler {
    store: CoreDocumentStore,
    cancellation: CancellationRegistry,
    generation: GenerationClient,
}

impl CoreFrameHandler {
    /// Creates a handler that routes FIM generation through `generation`.
    #[must_use]
    pub fn new(generation: GenerationClient) -> Self {
        Self {
            store: CoreDocumentStore::new(),
            cancellation: CancellationRegistry::new(),
            generation,
        }
    }

    /// Handles one client frame, emitting any server frames through `out`.
    pub fn handle(
        &mut self,
        frame: ClientFrame,
        out: &UnboundedSender<ServerFrame>,
    ) -> HandleOutcome {
        match frame {
            ClientFrame::InitialDocumentSnapshot(doc) | ClientFrame::OpenBufferSnapshot(doc) => {
                self.apply_snapshot(doc);
                HandleOutcome::Continue
            }
            ClientFrame::DocumentChange(change) => {
                self.apply_change(change);
                HandleOutcome::Continue
            }
            ClientFrame::CompletionRequest(request) => {
                self.start_completion(&request, out);
                HandleOutcome::Continue
            }
            ClientFrame::Cancel(cancel) => {
                self.cancellation.cancel(cancel.request_id);
                HandleOutcome::Continue
            }
            ClientFrame::ConfigUpdate(_) => HandleOutcome::Continue,
            ClientFrame::Shutdown(_) => HandleOutcome::Shutdown,
        }
    }

    fn apply_snapshot(&mut self, doc: WireInitialDocument) {
        self.store.upsert_initial_snapshot(to_initial_snapshot(doc));
    }

    fn apply_change(&mut self, change: WireDocumentChange) {
        let WireDocumentChange {
            uri,
            from_version,
            to_version,
            changes,
        } = change;
        let changes = to_content_changes(changes);

        if let Err(err) = self
            .store
            .apply_changes(&uri, from_version, to_version, &changes)
        {
            tracing::warn!(error = %err, uri = %uri, "failed to apply document change");
        }
    }

    fn start_completion(
        &mut self,
        request: &WireCompletionRequest,
        out: &UnboundedSender<ServerFrame>,
    ) {
        if request.mode != CompletionMode::Fim {
            send_error(out, request.request_id, "pilot routes FIM only");
            return;
        }

        let Some(module) = FimModuleKind::by_model_id(&request.model_id) else {
            send_error(out, request.request_id, "unsupported FIM model");
            return;
        };

        let prompt = match self.build_prompt(module, request) {
            Ok(prompt) => prompt,
            Err(message) => {
                send_error(out, request.request_id, &message);
                return;
            }
        };

        let cancel = self.cancellation.start(request.request_id);
        spawn_fim_completion(FimCompletion {
            client: self.generation.clone(),
            prompt,
            max_tokens: module.max_tokens(GenerationMode::Line),
            stop: module.stop_tokens(),
            cancel,
            out: out.clone(),
            request_id: request.request_id,
        });
    }

    fn build_prompt(
        &self,
        module: FimModuleKind,
        request: &WireCompletionRequest,
    ) -> Result<String, String> {
        let (prefix, suffix) = self
            .store
            .prefix_suffix_at(&request.uri, request.version, request.cursor)
            .map_err(|err| err.to_string())?;
        // Metadata rides through the existing repo-context channel, so the
        // model sees it now without waiting for a dedicated retrieval stage.
        let neighbors = self.prompt_context_neighbors(request);

        let input = FimRenderInput {
            language_id: &request.language_id,
            file_path: &request.uri,
            prefix,
            suffix,
            neighbors: &neighbors,
            generation_mode: GenerationMode::Line,
        };
        Ok(module.render_prompt(&input))
    }
}

fn send_error(out: &UnboundedSender<ServerFrame>, request_id: u64, message: &str) {
    let _ = out.send(ServerFrame::Error {
        request_id,
        message: message.to_owned(),
    });
}

fn to_initial_snapshot(doc: WireInitialDocument) -> InitialDocumentSnapshot {
    InitialDocumentSnapshot {
        uri: doc.uri,
        version: doc.version,
        language_id: doc.language_id,
        file_path: doc.file_path,
        file_mode: doc.file_mode,
        text: doc.text,
    }
}

fn to_content_changes(changes: Vec<WireTextChange>) -> Vec<DocumentContentChange> {
    changes
        .into_iter()
        .map(|change| DocumentContentChange {
            range: change.range,
            range_length: change.range_length,
            inserted_text: change.inserted_text,
        })
        .collect()
}

impl CoreFrameHandler {
    // Related-file hints now resolve to real file contents before the prompt is
    // rendered; the remaining metadata still flows through pseudo-files.
    fn prompt_context_neighbors(&self, request: &WireCompletionRequest) -> Vec<Neighbor> {
        let mut neighbors = self.related_hint_neighbors(request);

        if let Some(neighbor) = diagnostics_neighbor(request) {
            neighbors.push(neighbor);
        }
        if let Some(neighbor) = outline_neighbor(request) {
            neighbors.push(neighbor);
        }
        if let Some(neighbor) = signals_neighbor(request) {
            neighbors.push(neighbor);
        }

        neighbors
    }

    // Related-file hints only carry workspace-relative paths, so the core uses
    // the synchronized current-file metadata to resolve and read them itself.
    fn related_hint_neighbors(&self, request: &WireCompletionRequest) -> Vec<Neighbor> {
        let Some((workspace_root, current_file_path)) = self.workspace_context(request) else {
            return Vec::new();
        };

        let mut loaded = Vec::with_capacity(request.related_file_hints.len());
        for (index, hint) in request.related_file_hints.iter().enumerate() {
            if hint.path == current_file_path {
                continue;
            }
            if let Some(neighbor) = load_related_hint_neighbor(&workspace_root, hint) {
                loaded.push(LoadedRelatedHint {
                    neighbor,
                    score_hint: hint.score_hint,
                    has_range: hint.range.is_some(),
                    source_index: index,
                });
            }
        }

        rank_related_hints(loaded)
    }

    fn workspace_context(&self, request: &WireCompletionRequest) -> Option<(PathBuf, &str)> {
        let current_file = self
            .store
            .file_path_at(&request.uri, request.version)
            .ok()
            .flatten()?;
        Some((
            derive_workspace_root(&request.uri, current_file)?,
            current_file,
        ))
    }
}

struct LoadedRelatedHint {
    neighbor: Neighbor,
    score_hint: f32,
    has_range: bool,
    source_index: usize,
}

fn load_related_hint_neighbor(
    workspace_root: &Path,
    hint: &WireRelatedFileHint,
) -> Option<Neighbor> {
    let path = workspace_root.join(&hint.path);
    let text = std::fs::read_to_string(&path).ok()?;
    let text = clip_related_file(&text, hint.range);

    Some(metadata_neighbor(hint.path.clone(), text))
}

// Loaded related files are re-ranked in the core so prompt ordering stays
// stable even when some hints fail to load or point back to the current file.
fn rank_related_hints(mut loaded: Vec<LoadedRelatedHint>) -> Vec<Neighbor> {
    loaded.sort_by(|left, right| {
        right
            .score_hint
            .total_cmp(&left.score_hint)
            .then_with(|| right.has_range.cmp(&left.has_range))
            .then_with(|| left.source_index.cmp(&right.source_index))
    });

    let mut selected = Vec::with_capacity(loaded.len().min(MAX_RELATED_HINT_NEIGHBORS));
    for candidate in loaded {
        if selected
            .iter()
            .any(|neighbor: &Neighbor| neighbor.file_path == candidate.neighbor.file_path)
        {
            continue;
        }
        selected.push(candidate.neighbor);
        if selected.len() >= MAX_RELATED_HINT_NEIGHBORS {
            break;
        }
    }
    selected
}

fn derive_workspace_root(uri: &str, relative_file_path: &str) -> Option<PathBuf> {
    let mut absolute_path = file_uri_to_path(uri)?;
    let component_count = Path::new(relative_file_path).components().count();
    for _ in 0..component_count {
        if !absolute_path.pop() {
            return None;
        }
    }
    Some(absolute_path)
}

fn file_uri_to_path(uri: &str) -> Option<PathBuf> {
    let path = uri.strip_prefix("file://")?;
    Some(PathBuf::from(path))
}

fn clip_related_file(text: &str, range: Option<Range>) -> String {
    match range {
        Some(range) => clip_related_window(text, range),
        None => clip_related_prefix(text),
    }
}

fn clip_related_window(text: &str, range: Range) -> String {
    const WINDOW_RADIUS: usize = 12;
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return String::new();
    }

    let start = usize::try_from(range.start_line)
        .unwrap_or(0)
        .saturating_sub(WINDOW_RADIUS);
    let end_line = usize::try_from(range.end_line)
        .unwrap_or(0)
        .saturating_add(WINDOW_RADIUS);
    let end = end_line.min(lines.len().saturating_sub(1));
    let mut clipped = String::new();
    clipped.push_str(lines[start]);
    for line in &lines[start + 1..=end] {
        clipped.push('\n');
        clipped.push_str(line);
    }
    clipped
}

fn clip_related_prefix(text: &str) -> String {
    const MAX_CHARS: usize = 4_000;
    if text.len() <= MAX_CHARS {
        return text.to_owned();
    }
    text[..MAX_CHARS].to_owned()
}

// Diagnostics become a pseudo-file so compiler friction reaches the model via
// the same repo-context path as ordinary retrieved files.
fn diagnostics_neighbor(request: &WireCompletionRequest) -> Option<Neighbor> {
    if request.diagnostics.is_empty() {
        return None;
    }

    let mut text = String::new();
    for diagnostic in &request.diagnostics {
        append_diagnostic_line(&mut text, diagnostic);
    }

    Some(metadata_neighbor(
        format!("diagnostics/{}", request.uri),
        text,
    ))
}

fn append_diagnostic_line(text: &mut String, diagnostic: &WireDiagnostic) {
    let _ = write!(
        text,
        "Line {} [{}]",
        diagnostic.range.start_line + 1,
        diagnostic_severity_label(diagnostic.severity),
    );
    if let Some(code) = &diagnostic.code {
        let _ = write!(text, " {code}");
    }
    let _ = writeln!(text, ": {}", diagnostic.message);
}

// Outline stays as structured text because the current Qwen repo-context format
// already knows how to order file-like context blocks.
fn outline_neighbor(request: &WireCompletionRequest) -> Option<Neighbor> {
    if request.outline.is_empty() {
        return None;
    }

    let mut text = String::new();
    for item in &request.outline {
        append_outline_line(&mut text, item);
    }

    Some(metadata_neighbor(format!("outline/{}", request.uri), text))
}

fn append_outline_line(text: &mut String, item: &WireOutlineItem) {
    let _ = writeln!(
        text,
        "{} {} [{}:{}-{}:{}]",
        item.name,
        item.kind,
        item.range.start_line + 1,
        item.range.start_col,
        item.range.end_line + 1,
        item.range.end_col,
    );
}

// Raw signals are flattened into one block so the core can benefit from them
// now, before a dedicated retrieval/query stage consumes them directly.
fn signals_neighbor(request: &WireCompletionRequest) -> Option<Neighbor> {
    let signals = request.signals.as_ref()?;
    let mut text = String::new();

    append_signal_value(
        &mut text,
        "symbol_at_cursor",
        signals.symbol_at_cursor.as_deref(),
    );
    append_signal_list(&mut text, "renamed_symbols", &signals.renamed_symbols);
    append_signal_list(&mut text, "imported_symbols", &signals.imported_symbols);
    append_signal_list(&mut text, "declared_types", &signals.declared_types);
    append_signal_list(&mut text, "test_names", &signals.test_names);
    append_signal_list(&mut text, "diagnostic_symbols", &signals.diagnostic_symbols);
    append_signal_list(&mut text, "fuzzy_symbols", &signals.fuzzy_symbols);
    append_signal_list(
        &mut text,
        "retrieval_signal_hints",
        &signals.retrieval_signal_hints,
    );
    if let Some(region) = request.editable_region {
        let _ = writeln!(
            text,
            "editable_region: [{}:{}-{}:{}]",
            region.start_line + 1,
            region.start_col,
            region.end_line + 1,
            region.end_col,
        );
    }

    if text.is_empty() {
        return None;
    }

    Some(metadata_neighbor(format!("signals/{}", request.uri), text))
}

fn append_signal_value(text: &mut String, label: &str, value: Option<&str>) {
    if let Some(value) = value.filter(|value| !value.is_empty()) {
        let _ = writeln!(text, "{label}: {value}");
    }
}

fn append_signal_list(text: &mut String, label: &str, values: &[String]) {
    if values.is_empty() {
        return;
    }

    let _ = write!(text, "{label}: ");
    append_joined_values(text, values);
    text.push('\n');
}

fn append_joined_values(text: &mut String, values: &[String]) {
    text.push_str(&values[0]);
    for value in &values[1..] {
        let _ = write!(text, ", {value}");
    }
}

fn diagnostic_severity_label(severity: WireDiagnosticSeverity) -> &'static str {
    match severity {
        WireDiagnosticSeverity::Error => "error",
        WireDiagnosticSeverity::Warning => "warning",
        WireDiagnosticSeverity::Info => "info",
        WireDiagnosticSeverity::Hint => "hint",
    }
}

// Pseudo-files keep model-specific prompt builders oblivious to where a block
// came from: retrieval, diagnostics, outline, or frontend-only signals.
fn metadata_neighbor(file_path: String, text: String) -> Neighbor {
    Neighbor {
        id: file_path.clone(),
        file_path,
        range: Range {
            start_line: 0,
            start_col: 0,
            end_line: 0,
            end_col: 0,
        },
        text,
        score: 0.0,
    }
}
