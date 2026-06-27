//! Client-frame handler: document sync plus the FIM pilot route.

use std::fmt::Write;
use std::path::{Path, PathBuf};

use core_dispatch::CancellationRegistry;
use core_documents::{
    CoreDocumentStore, DocumentContentChange, InitialDocumentSnapshot, SweepOriginalContext,
    SweepWindowLayout,
};
use core_edit_history::RecentEdit;
use core_ipc::{
    ClientFrame, ServerFrame, WireCompletionRequest, WireConfigUpdate, WireDiagnostic,
    WireDiagnosticSeverity, WireDocumentChange, WireInitialDocument, WireOutlineItem,
    WireRelatedFileHint, WireSignals, WireTextChange,
};
use core_llama::{looks_broken, GenerationClient, RerankClient};
use core_models::{
    FimModelModule, FimModuleKind, FimRenderInput, GenerationMode, NesModelModule, NesModuleKind,
    NesRenderInput,
};
use core_retrieval::{
    rrf_merge, ChannelInput, FuzzyFimChannel, FuzzyNesChannel, GraphChannel, RetrievalChannelKind,
    RetrievalConfig, RetrievalDocument, SemanticChannel,
};
use core_types::{CompletionMode, Neighbor, Range};
use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;

use crate::completion::{spawn_fim_completion, spawn_nes_completion, FimCompletion, NesCompletion};

const MAX_RELATED_HINT_NEIGHBORS: usize = 6;
/// Upper bound on a single related-file read, guarding prompt budget and latency.
const MAX_RELATED_FILE_BYTES: u64 = 256 * 1024;

/// What the connection loop should do after one frame.
pub enum HandleOutcome {
    /// Keep serving the connection.
    Continue,
    /// Stop serving and shut the core down.
    Shutdown,
}

/// Applies client frames to the shadow store and routes FIM/NES completions.
pub struct CoreFrameHandler {
    store: CoreDocumentStore,
    cancellation: CancellationRegistry,
    fim_generation: GenerationClient,
    nes_generation: GenerationClient,
    config: CoreConfigState,
}

impl CoreFrameHandler {
    /// Creates a handler routing FIM and NES generation to separate endpoints.
    ///
    /// FIM and NES run on distinct llama-server instances (different ports and
    /// GPUs), so each gets its own client instead of sharing one.
    #[must_use]
    pub fn new(fim_generation: GenerationClient, nes_generation: GenerationClient) -> Self {
        Self {
            store: CoreDocumentStore::new(),
            cancellation: CancellationRegistry::new(),
            fim_generation,
            nes_generation,
            config: CoreConfigState::new(),
        }
    }

    /// Handles one client frame, emitting any server frames through `out`.
    ///
    /// Async because related-file context is read off the reactor via
    /// `tokio::fs`; document sync and cancellation stay synchronous.
    pub async fn handle(
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
                self.start_completion(&request, out).await;
                HandleOutcome::Continue
            }
            ClientFrame::Cancel(cancel) => {
                self.cancellation.cancel(cancel.request_id);
                HandleOutcome::Continue
            }
            ClientFrame::ConfigUpdate(update) => {
                self.config.apply(update);
                HandleOutcome::Continue
            }
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

    async fn start_completion(
        &mut self,
        request: &WireCompletionRequest,
        out: &UnboundedSender<ServerFrame>,
    ) {
        match request.mode {
            CompletionMode::Fim => self.start_fim_completion(request, out).await,
            CompletionMode::Nes => self.start_nes_completion(request, out).await,
        }
    }

    async fn start_fim_completion(
        &mut self,
        request: &WireCompletionRequest,
        out: &UnboundedSender<ServerFrame>,
    ) {
        let Some(module) = FimModuleKind::by_model_id(&request.model_id) else {
            send_error(out, request.request_id, "unsupported FIM model");
            return;
        };

        let prompt = match self.build_fim_prompt(module, request).await {
            Ok(prompt) => prompt,
            Err(message) => {
                send_error(out, request.request_id, &message);
                return;
            }
        };

        let cancel = self.cancellation.start(request.request_id);
        spawn_fim_completion(FimCompletion {
            client: self.fim_generation.clone(),
            prompt,
            max_tokens: module.max_tokens(GenerationMode::Line),
            stop: module.stop_tokens(),
            cancel,
            out: out.clone(),
            request_id: request.request_id,
        });
    }

    async fn start_nes_completion(
        &mut self,
        request: &WireCompletionRequest,
        out: &UnboundedSender<ServerFrame>,
    ) {
        let Some(module) = NesModuleKind::by_model_id(&request.model_id) else {
            send_error(out, request.request_id, "unsupported NES model");
            return;
        };

        let prepared = match self.build_nes_completion(module, request).await {
            Ok(prepared) => prepared,
            Err(message) => {
                send_error(out, request.request_id, &message);
                return;
            }
        };

        let cancel = self.cancellation.start(request.request_id);
        spawn_nes_completion(NesCompletion {
            client: self.nes_generation.clone(),
            prompt: prepared.prompt,
            max_tokens: prepared.max_tokens,
            stop: prepared.stop,
            cancel,
            out: out.clone(),
            request_id: request.request_id,
            current_window_text: prepared.current_window_text,
            window_start_line: prepared.window_start_line,
            cursor_byte_offset: prepared.cursor_byte_offset,
        });
    }

    async fn build_fim_prompt(
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
        let neighbors = self.prompt_context_neighbors(request).await;
        let file_path = self.current_file_path(request)?;

        let input = FimRenderInput {
            language_id: &request.language_id,
            file_path: &file_path,
            prefix,
            suffix,
            neighbors: &neighbors,
            generation_mode: GenerationMode::Line,
        };
        Ok(module.render_prompt(&input))
    }

    async fn build_nes_completion(
        &self,
        module: NesModuleKind,
        request: &WireCompletionRequest,
    ) -> Result<PreparedNesCompletion, String> {
        // Neighbors are loaded first so the store borrow in `sweep_snapshot`
        // is never held across the `tokio::fs` await points.
        let neighbors = self.prompt_context_neighbors(request).await;
        let snapshot = self.sweep_snapshot(request)?;
        let file_path = self.current_file_path(request)?;

        let input = NesRenderInput {
            language_id: &request.language_id,
            file_path: &file_path,
            original_window: snapshot.original.as_ref(),
            current_window: snapshot.current.text,
            window_start_line: snapshot.current.start_line,
            window_line_count: snapshot.current.line_count,
            cursor_byte_offset: snapshot.current.cursor_byte_offset,
            broad_file_text: snapshot.broad.text,
            neighbors: &neighbors,
        };

        Ok(PreparedNesCompletion {
            prompt: module.render_prompt(&input),
            max_tokens: sweep_max_tokens(&request.model_id),
            stop: module.stop_tokens(),
            current_window_text: snapshot.current.text.to_owned(),
            window_start_line: snapshot.current.start_line,
            cursor_byte_offset: snapshot.current.cursor_byte_offset,
        })
    }

    fn sweep_snapshot<'a>(
        &'a self,
        request: &'a WireCompletionRequest,
    ) -> Result<core_documents::SweepDocumentSnapshot<'a>, String> {
        let recent_edits = recent_edits_from_wire(&request.recent_edits);
        self.store
            .sweep_snapshot_at(
                &request.uri,
                request.version,
                request.cursor,
                sweep_window_layout(&request.model_id),
                SweepOriginalContext {
                    pre_edit_text: request.original_window_text.as_deref(),
                    recent_edits: &recent_edits,
                },
            )
            .map_err(|err| err.to_string())
    }

    fn current_file_path(&self, request: &WireCompletionRequest) -> Result<String, String> {
        let path = self
            .store
            .file_path_at(&request.uri, request.version)
            .map_err(|err| err.to_string())?
            .unwrap_or(&request.uri);
        Ok(path.to_owned())
    }
}

struct PreparedNesCompletion {
    prompt: String,
    max_tokens: u32,
    stop: &'static [&'static str],
    current_window_text: String,
    window_start_line: usize,
    cursor_byte_offset: usize,
}

struct CoreConfigState {
    version: u64,
    config_json: String,
}

impl CoreConfigState {
    fn new() -> Self {
        Self {
            version: 0,
            config_json: String::new(),
        }
    }

    // Monotonic by version so a late, out-of-order frame cannot roll config back.
    fn apply(&mut self, update: WireConfigUpdate) {
        if update.config_version < self.version {
            return;
        }
        self.version = update.config_version;
        self.config_json = update.config_json;
    }

    fn runtime_config_for(&self, request: &WireCompletionRequest) -> RuntimeRequestConfig {
        let request_value = request.config_json.as_deref().and_then(parse_json_value);
        let stored_value = if request_value.is_none() {
            parse_json_value(&self.config_json)
        } else {
            None
        };
        RuntimeRequestConfig::from_json(
            request.mode,
            request.model_id.as_str(),
            request_value.or(stored_value),
        )
    }
}

#[derive(Clone)]
struct RuntimeRequestConfig {
    retrieval: RetrievalConfig,
    top_n: usize,
    rerank: RuntimeRerankConfig,
}

#[derive(Clone)]
struct RuntimeRerankConfig {
    enabled: bool,
    endpoint: String,
    instruction: String,
    candidate_pool_n: usize,
    rerank_top_n: usize,
    final_top_n: usize,
    max_doc_chars: usize,
}

impl RuntimeRequestConfig {
    fn from_json(mode: CompletionMode, model_id: &str, value: Option<Value>) -> Self {
        let defaults = default_runtime_config(mode, model_id);
        let Some(value) = value else {
            return defaults;
        };

        let section = request_mode_section(&value, mode);
        let retrieval_section = section.and_then(|section| section.get("retrieval"));
        let rerank_section = retrieval_section.and_then(|section| section.get("rerank"));

        Self {
            retrieval: RetrievalConfig {
                semantic_enabled: true,
                graph_enabled: bool_at_paths(
                    retrieval_section,
                    &[&["graph", "enabled"]],
                    defaults.retrieval.graph_enabled,
                ),
                fuzzy_enabled: bool_at_paths(
                    retrieval_section,
                    &[&["fuzzy", "enabled"]],
                    defaults.retrieval.fuzzy_enabled,
                ),
            },
            top_n: usize_at_paths(section, &[&["relatedTopN"]], defaults.top_n),
            rerank: RuntimeRerankConfig {
                enabled: bool_at_paths(rerank_section, &[&["enabled"]], defaults.rerank.enabled),
                endpoint: normalize_rerank_endpoint(string_at_paths(
                    rerank_section,
                    &[&["llamaUrl"]],
                    &defaults.rerank.endpoint,
                )),
                instruction: string_at_paths(
                    rerank_section,
                    &[&["instruction"]],
                    &defaults.rerank.instruction,
                ),
                candidate_pool_n: usize_at_paths(
                    rerank_section,
                    &[&["candidatePoolN"]],
                    defaults.rerank.candidate_pool_n,
                ),
                rerank_top_n: usize_at_paths(
                    rerank_section,
                    &[&["rerankTopN"]],
                    defaults.rerank.rerank_top_n,
                ),
                final_top_n: usize_at_paths(
                    rerank_section,
                    &[&["finalTopN"]],
                    defaults.rerank.final_top_n,
                ),
                max_doc_chars: usize_at_paths(
                    rerank_section,
                    &[&["maxDocChars"]],
                    defaults.rerank.max_doc_chars,
                ),
            },
        }
    }
}

fn default_runtime_config(mode: CompletionMode, _model_id: &str) -> RuntimeRequestConfig {
    match mode {
        CompletionMode::Fim => RuntimeRequestConfig {
            retrieval: RetrievalConfig {
                semantic_enabled: true,
                graph_enabled: true,
                fuzzy_enabled: true,
            },
            top_n: 5,
            rerank: RuntimeRerankConfig {
                enabled: true,
                endpoint: "http://127.0.0.1:8030/v1/rerank".to_owned(),
                instruction: "Instruct: Given the current incomplete code prefix and recent edits, judge whether the repository snippet is useful for predicting the missing code at the cursor.".to_owned(),
                candidate_pool_n: 16,
                rerank_top_n: 16,
                final_top_n: 5,
                max_doc_chars: 2000,
            },
        },
        CompletionMode::Nes => RuntimeRequestConfig {
            retrieval: RetrievalConfig {
                semantic_enabled: true,
                graph_enabled: true,
                fuzzy_enabled: true,
            },
            top_n: 8,
            rerank: RuntimeRerankConfig {
                enabled: false,
                endpoint: "http://127.0.0.1:8030/v1/rerank".to_owned(),
                instruction: "Instruct: Given the current code edit and cursor context, judge whether the code snippet is useful for predicting the developer's next edit. Prefer snippets that define or call the symbols being edited.".to_owned(),
                candidate_pool_n: 24,
                rerank_top_n: 16,
                final_top_n: 8,
                max_doc_chars: 2000,
            },
        },
    }
}

fn request_mode_section(value: &Value, mode: CompletionMode) -> Option<&Value> {
    match mode {
        CompletionMode::Fim => value.get("fim"),
        CompletionMode::Nes => value.get("nes"),
    }
}

fn parse_json_value(text: &str) -> Option<Value> {
    if text.is_empty() {
        return None;
    }
    serde_json::from_str(text).ok()
}

fn bool_at_paths(value: Option<&Value>, paths: &[&[&str]], default: bool) -> bool {
    paths
        .iter()
        .find_map(|path| {
            value
                .and_then(|value| value.pointer(&json_pointer(path)))
                .and_then(Value::as_bool)
        })
        .unwrap_or(default)
}

fn usize_at_paths(value: Option<&Value>, paths: &[&[&str]], default: usize) -> usize {
    paths
        .iter()
        .find_map(|path| {
            value
                .and_then(|value| value.pointer(&json_pointer(path)))
                .and_then(Value::as_u64)
        })
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(default)
}

fn string_at_paths(value: Option<&Value>, paths: &[&[&str]], default: &str) -> String {
    paths
        .iter()
        .find_map(|path| {
            value
                .and_then(|value| value.pointer(&json_pointer(path)))
                .and_then(Value::as_str)
        })
        .unwrap_or(default)
        .to_owned()
}

fn normalize_rerank_endpoint(value: String) -> String {
    if value.ends_with("/rerank") {
        return value;
    }
    let trimmed = value.trim_end_matches('/');
    format!("{trimmed}/rerank")
}

fn json_pointer(path: &[&str]) -> String {
    let mut pointer = String::new();
    for part in path {
        pointer.push('/');
        pointer.push_str(part);
    }
    pointer
}

fn sweep_window_layout(model_id: &str) -> SweepWindowLayout {
    match model_id {
        "sweep-small" => SweepWindowLayout {
            before: 10,
            after: 10,
            broad: 160,
        },
        _ => SweepWindowLayout {
            before: 10,
            after: 10,
            broad: 300,
        },
    }
}

fn sweep_max_tokens(_model_id: &str) -> u32 {
    768
}

fn recent_edits_from_wire(edits: &[core_ipc::WireRecentEdit]) -> Vec<RecentEdit> {
    edits
        .iter()
        .map(|edit| RecentEdit {
            uri: edit.uri.clone(),
            unified_diff: edit.unified_diff.clone(),
            timestamp: edit.timestamp,
        })
        .collect()
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

async fn retrieve_neighbors(input: &ChannelInput, runtime: RuntimeRequestConfig) -> Vec<Neighbor> {
    let channels = [
        RetrievalChannelKind::Semantic(SemanticChannel),
        RetrievalChannelKind::Graph(GraphChannel),
        RetrievalChannelKind::FuzzyFim(FuzzyFimChannel),
        RetrievalChannelKind::FuzzyNes(FuzzyNesChannel),
    ];

    let mut lists = Vec::with_capacity(channels.len());
    let pool_n = runtime.rerank.candidate_pool_n.max(runtime.top_n).max(1);
    for channel in channels {
        if channel.code_only() && !input.file_mode_is_code {
            continue;
        }
        if !channel.is_enabled(runtime.retrieval) {
            continue;
        }
        lists.push(channel.retrieve(input, pool_n));
    }

    let merged = rrf_merge(&lists, pool_n);
    rerank_neighbors(merged, &input.query_text, runtime.rerank).await
}

async fn rerank_neighbors(
    merged: Vec<Neighbor>,
    query_text: &str,
    rerank: RuntimeRerankConfig,
) -> Vec<Neighbor> {
    let final_top_n = rerank.final_top_n.max(1);
    if !rerank.enabled {
        return merged.into_iter().take(final_top_n).collect();
    }

    let candidate_count = merged.len().min(rerank.rerank_top_n.max(final_top_n));
    let candidates = &merged[..candidate_count];
    let documents = candidates
        .iter()
        .map(|neighbor| clip_utf8_prefix(&neighbor.text, rerank.max_doc_chars))
        .collect::<Vec<_>>();
    let query = format!("{}\nQuery: {}", rerank.instruction, query_text);
    let reranker = RerankClient::new(rerank.endpoint);
    let ranked = match reranker.rerank(&query, &documents, documents.len()).await {
        Ok(ranked) if !looks_broken(&ranked) => ranked,
        _ => return merged.into_iter().take(final_top_n).collect(),
    };

    let mut selected = Vec::with_capacity(final_top_n);
    let mut used = std::collections::HashSet::with_capacity(ranked.len());
    for item in ranked {
        if item.index >= candidates.len() || !used.insert(item.index) {
            continue;
        }
        let mut neighbor = candidates[item.index].clone();
        neighbor.score = item.relevance_score;
        selected.push(neighbor);
        if selected.len() >= final_top_n {
            break;
        }
    }
    if selected.len() < final_top_n {
        for neighbor in merged {
            if selected
                .iter()
                .any(|selected_neighbor| selected_neighbor.id == neighbor.id)
            {
                continue;
            }
            selected.push(neighbor);
            if selected.len() >= final_top_n {
                break;
            }
        }
    }
    selected
}

fn retrieval_query_text(request: &WireCompletionRequest) -> String {
    let mut parts = Vec::new();
    if let Some(signals) = request.signals.as_ref() {
        if let Some(symbol) = signals.symbol_at_cursor.as_ref() {
            if !symbol.is_empty() {
                parts.push(symbol.clone());
            }
        }
        append_signal_values(&mut parts, &signals.renamed_symbols);
        append_signal_values(&mut parts, &signals.imported_symbols);
        append_signal_values(&mut parts, &signals.declared_types);
        append_signal_values(&mut parts, &signals.test_names);
        append_signal_values(&mut parts, &signals.diagnostic_symbols);
        append_signal_values(&mut parts, &signals.fuzzy_symbols);
        append_signal_values(&mut parts, &signals.retrieval_signal_hints);
    }
    if parts.is_empty() {
        for diagnostic in &request.diagnostics {
            parts.push(diagnostic.message.clone());
        }
    }
    parts.join("\n")
}

fn append_signal_values(out: &mut Vec<String>, values: &[String]) {
    for value in values {
        if !value.is_empty() {
            out.push(value.clone());
        }
    }
}

impl CoreFrameHandler {
    // Related-file hints and metadata pseudo-files are collected into a corpus,
    // then ranked through the in-core retrieval channels and optional rerank.
    async fn prompt_context_neighbors(&self, request: &WireCompletionRequest) -> Vec<Neighbor> {
        let current_file_path = self
            .current_file_path(request)
            .unwrap_or_else(|_| request.uri.clone());
        let runtime = self.config.runtime_config_for(request);
        let documents = self.related_hint_documents(request).await;

        let mut neighbors = if documents.is_empty() {
            Vec::new()
        } else {
            let query_text = retrieval_query_text(request);
            let input = ChannelInput {
                query_text: query_text.clone(),
                vector_text: query_text,
                file_mode_is_code: request.file_mode == core_types::FileMode::Code,
                current_file_path,
                documents,
                signal_terms: signal_terms(request.signals.as_ref()),
            };
            retrieve_neighbors(&input, runtime).await
        };

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
    async fn related_hint_documents(
        &self,
        request: &WireCompletionRequest,
    ) -> Vec<RetrievalDocument> {
        let Some((workspace_root, current_file_path)) = self.workspace_context(request) else {
            return Vec::new();
        };

        let mut loaded = Vec::with_capacity(request.related_file_hints.len());
        for (index, hint) in request.related_file_hints.iter().enumerate() {
            if hint.path == current_file_path {
                continue;
            }
            if let Some(document) = load_related_hint_document(&workspace_root, hint).await {
                loaded.push(LoadedRelatedHint {
                    document,
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
    document: RetrievalDocument,
    score_hint: f32,
    has_range: bool,
    source_index: usize,
}

async fn load_related_hint_document(
    workspace_root: &Path,
    hint: &WireRelatedFileHint,
) -> Option<RetrievalDocument> {
    let path = workspace_root.join(&hint.path);
    // Cap the read so a pathologically large related file cannot blow the
    // prompt budget or stall the reactor; oversized files are skipped.
    let metadata = tokio::fs::metadata(&path).await.ok()?;
    if metadata.len() > MAX_RELATED_FILE_BYTES {
        return None;
    }
    let text = tokio::fs::read_to_string(&path).await.ok()?;
    let text = clip_related_file(&text, hint.range);

    Some(RetrievalDocument {
        id: hint.path.clone(),
        file_path: hint.path.clone(),
        range: hint.range.unwrap_or(Range {
            start_line: 0,
            start_col: 0,
            end_line: 0,
            end_col: 0,
        }),
        text,
        source_hint: hint.source.clone(),
        score_hint: hint.score_hint,
    })
}

// Loaded related files are pre-ordered stably before the retrieval channels run
// so ties remain deterministic when scores land exactly equal.
fn rank_related_hints(mut loaded: Vec<LoadedRelatedHint>) -> Vec<RetrievalDocument> {
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
            .any(|document: &RetrievalDocument| document.file_path == candidate.document.file_path)
        {
            continue;
        }
        selected.push(candidate.document);
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
    const MAX_BYTES: usize = 4_000;
    clip_utf8_prefix(text, MAX_BYTES).to_owned()
}

// Byte slicing a `&str` panics if the cut lands inside a multi-byte UTF-8
// sequence, so the clip walks back to the nearest char boundary first.
fn clip_utf8_prefix(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }

    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }

    &text[..end]
}

// Signal terms give the core a lightweight relevance pass before a real
// retrieval backend consumes the same envelope metadata more deeply.
fn signal_terms(signals: Option<&WireSignals>) -> Vec<String> {
    let Some(signals) = signals else {
        return Vec::new();
    };

    let mut terms = Vec::with_capacity(16);
    push_signal_value(&mut terms, signals.symbol_at_cursor.as_deref());
    push_signal_list(&mut terms, &signals.renamed_symbols);
    push_signal_list(&mut terms, &signals.imported_symbols);
    push_signal_list(&mut terms, &signals.declared_types);
    push_signal_list(&mut terms, &signals.test_names);
    push_signal_list(&mut terms, &signals.diagnostic_symbols);
    push_signal_list(&mut terms, &signals.fuzzy_symbols);
    push_signal_list(&mut terms, &signals.retrieval_signal_hints);
    terms.sort_unstable();
    terms.dedup();
    terms
}

fn push_signal_list(terms: &mut Vec<String>, values: &[String]) {
    for value in values {
        push_signal_value(terms, Some(value.as_str()));
    }
}

fn push_signal_value(terms: &mut Vec<String>, value: Option<&str>) {
    let Some(value) = value else {
        return;
    };
    for token in split_signal_tokens(value) {
        if token.len() >= 3 {
            terms.push(token.to_owned());
        }
    }
}

fn split_signal_tokens(value: &str) -> impl Iterator<Item = &str> {
    value
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|token| !token.is_empty())
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
