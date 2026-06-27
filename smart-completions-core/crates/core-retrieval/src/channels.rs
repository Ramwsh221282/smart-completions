use core_types::Neighbor;

/// Identifies a retrieval channel for fusion bookkeeping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChannelId {
    /// Vector plus lexical semantic channel.
    Semantic,
    /// Code-graph channel backed by SQLite.
    Graph,
    /// Fuzzy channel tuned for FIM.
    FuzzyFim,
    /// Fuzzy channel tuned for NES.
    FuzzyNes,
}

/// Inputs shared by every channel for a single retrieval pass.
#[derive(Debug)]
pub struct ChannelInput {
    /// Lexical query text.
    pub query_text: String,
    /// Text embedded for the vector branch.
    pub vector_text: String,
    /// Whether the active document is code (enables code-only channels).
    pub file_mode_is_code: bool,
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

/// Behaviour shared by all channels; dispatched statically through the enum.
trait RetrievalChannel {
    fn id(&self) -> ChannelId;
    fn code_only(&self) -> bool;
    fn is_enabled(&self, config: RetrievalConfig) -> bool;
    fn retrieve(&self, input: &ChannelInput, top_n: usize) -> Vec<Neighbor>;
}

/// Static-dispatch set of retrieval channels.
///
/// Enum dispatch keeps the hot path free of `async_trait`/`Box<dyn>`. Bodies are
/// stubs until the LanceDB/Tantivy/SQLite backends land, so `retrieve` is
/// synchronous and returns no neighbors today.
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

/// Semantic channel: vector search plus lexical search fused internally.
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

    fn retrieve(&self, _input: &ChannelInput, _top_n: usize) -> Vec<Neighbor> {
        Vec::new()
    }
}

/// Code-graph channel backed by SQLite.
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

    fn retrieve(&self, _input: &ChannelInput, _top_n: usize) -> Vec<Neighbor> {
        Vec::new()
    }
}

/// Fuzzy channel tuned for FIM symbol queries.
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

    fn retrieve(&self, _input: &ChannelInput, _top_n: usize) -> Vec<Neighbor> {
        Vec::new()
    }
}

/// Fuzzy channel tuned for NES symbol queries.
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

    fn retrieve(&self, _input: &ChannelInput, _top_n: usize) -> Vec<Neighbor> {
        Vec::new()
    }
}
