use core_types::{Neighbor, Range};

/// Identifies a retrieval channel for fusion bookkeeping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChannelId {
    /// Lexical/semantic channel over document text and paths.
    Semantic,
    /// Structural graph-like channel driven by symbol/path hints.
    Graph,
    /// Fuzzy channel tuned for FIM.
    FuzzyFim,
    /// Fuzzy channel tuned for NES.
    FuzzyNes,
}

/// One retrieval candidate document available to the channels.
#[derive(Debug, Clone)]
pub struct RetrievalDocument {
    /// Stable identity for fusion/dedup.
    pub id: String,
    /// Workspace-relative path.
    pub file_path: String,
    /// Source range when known.
    pub range: Range,
    /// Candidate text.
    pub text: String,
    /// Origin of the candidate.
    pub source_hint: String,
    /// Source-provided score hint used as a final tie-breaker.
    pub score_hint: f32,
}

/// Inputs shared by every channel for a single retrieval pass.
#[derive(Debug, Clone)]
pub struct ChannelInput {
    /// Lexical query text.
    pub query_text: String,
    /// Text embedded for the vector branch.
    pub vector_text: String,
    /// Whether the active document is code (enables code-only channels).
    pub file_mode_is_code: bool,
    /// Workspace-relative current file path when known.
    pub current_file_path: String,
    /// Candidate documents.
    pub documents: Vec<RetrievalDocument>,
    /// Signal tokens extracted from cursor/diagnostic/import metadata.
    pub signal_terms: Vec<String>,
}

/// Toggles for which channels participate in a retrieval.
#[derive(Debug, Clone, Copy)]
pub struct RetrievalConfig {
    /// Enable the semantic channel.
    pub semantic_enabled: bool,
    /// Enable the graph channel.
    pub graph_enabled: bool,
    /// Enable the fuzzy channels.
    pub fuzzy_enabled: bool,
}

trait RetrievalChannel {
    fn id(&self) -> ChannelId;
    fn code_only(&self) -> bool;
    fn is_enabled(&self, config: RetrievalConfig) -> bool;
    fn retrieve(&self, input: &ChannelInput, top_n: usize) -> Vec<Neighbor>;
}

/// Static-dispatch set of retrieval channels.
#[derive(Debug)]
pub enum RetrievalChannelKind {
    /// Semantic channel variant.
    Semantic(SemanticChannel),
    /// Graph channel variant.
    Graph(GraphChannel),
    /// FIM-tuned fuzzy channel variant.
    FuzzyFim(FuzzyFimChannel),
    /// NES-tuned fuzzy channel variant.
    FuzzyNes(FuzzyNesChannel),
}

impl RetrievalChannelKind {
    /// Returns the identity of the wrapped channel.
    #[must_use]
    pub fn id(&self) -> ChannelId {
        match self {
            Self::Semantic(channel) => channel.id(),
            Self::Graph(channel) => channel.id(),
            Self::FuzzyFim(channel) => channel.id(),
            Self::FuzzyNes(channel) => channel.id(),
        }
    }

    /// Returns whether the channel only contributes in code documents.
    #[must_use]
    pub fn code_only(&self) -> bool {
        match self {
            Self::Semantic(channel) => channel.code_only(),
            Self::Graph(channel) => channel.code_only(),
            Self::FuzzyFim(channel) => channel.code_only(),
            Self::FuzzyNes(channel) => channel.code_only(),
        }
    }

    /// Returns whether the channel is enabled for the given config.
    #[must_use]
    pub fn is_enabled(&self, config: RetrievalConfig) -> bool {
        match self {
            Self::Semantic(channel) => channel.is_enabled(config),
            Self::Graph(channel) => channel.is_enabled(config),
            Self::FuzzyFim(channel) => channel.is_enabled(config),
            Self::FuzzyNes(channel) => channel.is_enabled(config),
        }
    }

    /// Retrieves up to `top_n` neighbors from the wrapped channel.
    #[must_use]
    pub fn retrieve(&self, input: &ChannelInput, top_n: usize) -> Vec<Neighbor> {
        match self {
            Self::Semantic(channel) => channel.retrieve(input, top_n),
            Self::Graph(channel) => channel.retrieve(input, top_n),
            Self::FuzzyFim(channel) => channel.retrieve(input, top_n),
            Self::FuzzyNes(channel) => channel.retrieve(input, top_n),
        }
    }
}

/// Semantic channel ranking candidates lexically over paths and text.
#[derive(Debug, Default)]
pub struct SemanticChannel;

impl RetrievalChannel for SemanticChannel {
    fn id(&self) -> ChannelId {
        ChannelId::Semantic
    }

    fn code_only(&self) -> bool {
        false
    }

    fn is_enabled(&self, config: RetrievalConfig) -> bool {
        config.semantic_enabled
    }

    fn retrieve(&self, input: &ChannelInput, top_n: usize) -> Vec<Neighbor> {
        let query_terms = query_terms(input);
        score_documents(input, top_n, |doc| semantic_score(doc, &query_terms))
    }
}

/// Graph-like structural channel driven by symbol/path hints.
#[derive(Debug, Default)]
pub struct GraphChannel;

impl RetrievalChannel for GraphChannel {
    fn id(&self) -> ChannelId {
        ChannelId::Graph
    }

    fn code_only(&self) -> bool {
        true
    }

    fn is_enabled(&self, config: RetrievalConfig) -> bool {
        config.graph_enabled
    }

    fn retrieve(&self, input: &ChannelInput, top_n: usize) -> Vec<Neighbor> {
        score_documents(input, top_n, |doc| graph_score(input, doc))
    }
}

/// Fuzzy channel tuned for FIM-style query tokens.
#[derive(Debug, Default)]
pub struct FuzzyFimChannel;

impl RetrievalChannel for FuzzyFimChannel {
    fn id(&self) -> ChannelId {
        ChannelId::FuzzyFim
    }

    fn code_only(&self) -> bool {
        true
    }

    fn is_enabled(&self, config: RetrievalConfig) -> bool {
        config.fuzzy_enabled
    }

    fn retrieve(&self, input: &ChannelInput, top_n: usize) -> Vec<Neighbor> {
        score_documents(input, top_n, |doc| fuzzy_score(input, doc, true))
    }
}

/// Fuzzy channel tuned for NES-style edit signals.
#[derive(Debug, Default)]
pub struct FuzzyNesChannel;

impl RetrievalChannel for FuzzyNesChannel {
    fn id(&self) -> ChannelId {
        ChannelId::FuzzyNes
    }

    fn code_only(&self) -> bool {
        true
    }

    fn is_enabled(&self, config: RetrievalConfig) -> bool {
        config.fuzzy_enabled
    }

    fn retrieve(&self, input: &ChannelInput, top_n: usize) -> Vec<Neighbor> {
        score_documents(input, top_n, |doc| fuzzy_score(input, doc, false))
    }
}

fn score_documents<F>(input: &ChannelInput, top_n: usize, rank_document: F) -> Vec<Neighbor>
where
    F: Fn(&RetrievalDocument) -> f32,
{
    let mut ranked = Vec::with_capacity(input.documents.len());
    for document in &input.documents {
        if document.file_path == input.current_file_path {
            continue;
        }
        let score = rank_document(document);
        if score <= 0.0 {
            continue;
        }
        ranked.push(to_neighbor(document, score));
    }
    ranked.sort_by(compare_neighbors_by_score);
    ranked.truncate(top_n);
    ranked
}

fn query_terms(input: &ChannelInput) -> Vec<String> {
    let mut terms = split_terms(&input.query_text);
    terms.extend(split_terms(&input.vector_text));
    terms.extend(input.signal_terms.iter().cloned());
    terms.sort_unstable();
    terms.dedup();
    terms
}

fn semantic_score(document: &RetrievalDocument, query_terms: &[String]) -> f32 {
    if query_terms.is_empty() {
        return 0.0;
    }

    let file_path = document.file_path.to_ascii_lowercase();
    let text = document.text.to_ascii_lowercase();
    let mut score = document.score_hint;
    for term in query_terms {
        if file_path.contains(term) {
            score += 4.0;
        }
        score += occurrence_score(&text, term, 1.5);
    }
    if document.source_hint == "definition" {
        score += 1.0;
    }
    score
}

fn graph_score(input: &ChannelInput, document: &RetrievalDocument) -> f32 {
    if input.signal_terms.is_empty() {
        return 0.0;
    }

    let file_path = document.file_path.to_ascii_lowercase();
    let text = document.text.to_ascii_lowercase();
    let mut score = document.score_hint;
    for term in &input.signal_terms {
        if file_path.contains(term) {
            score += 5.0;
        }
        score += occurrence_score(&text, term, 2.0);
    }
    if matches!(document.source_hint.as_str(), "definition" | "hierarchy") {
        score += 2.0;
    }
    score
}

fn fuzzy_score(input: &ChannelInput, document: &RetrievalDocument, prefer_query: bool) -> f32 {
    let mut needles = if prefer_query {
        split_terms(&input.query_text)
    } else {
        input.signal_terms.clone()
    };
    if needles.is_empty() {
        needles = query_terms(input);
    }
    if needles.is_empty() {
        return 0.0;
    }

    let haystack = identifier_tokens(document);
    let mut score = document.score_hint;
    for needle in &needles {
        for token in &haystack {
            if token == needle {
                score += 6.0;
            } else if token.starts_with(needle) {
                score += 3.5;
            } else if token.contains(needle) {
                score += 1.5;
            }
        }
    }
    score
}

fn identifier_tokens(document: &RetrievalDocument) -> Vec<String> {
    let mut tokens = split_terms(&document.file_path);
    tokens.extend(split_terms(&document.text));
    tokens
}

fn occurrence_score(text: &str, term: &str, weight: f32) -> f32 {
    if term.is_empty() {
        return 0.0;
    }
    let mut offset = 0;
    let mut hits = 0u16;
    while let Some(index) = text[offset..].find(term) {
        hits = hits.saturating_add(1);
        offset += index + term.len();
        if hits >= 8 {
            break;
        }
    }
    f32::from(hits) * weight
}

fn split_terms(value: &str) -> Vec<String> {
    value
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|term| term.len() >= 3)
        .map(str::to_ascii_lowercase)
        .collect()
}

fn to_neighbor(document: &RetrievalDocument, score: f32) -> Neighbor {
    Neighbor {
        id: document.id.clone(),
        file_path: document.file_path.clone(),
        range: document.range,
        text: document.text.clone(),
        score,
    }
}

fn compare_neighbors_by_score(left: &Neighbor, right: &Neighbor) -> std::cmp::Ordering {
    right
        .score
        .partial_cmp(&left.score)
        .unwrap_or(std::cmp::Ordering::Equal)
}
