//! Shared retrieval primitives.
//!
//! Cross-channel fusion uses reciprocal rank fusion. Channels are dispatched
//! through an enum so the hot path never pays for `async_trait`/`Box<dyn>`.
//! Channel bodies are stubs until the LanceDB/Tantivy/SQLite backends land.

mod channels;
mod fusion;

pub use channels::{
    ChannelId, ChannelInput, FuzzyFimChannel, FuzzyNesChannel, GraphChannel, RetrievalChannelKind,
    RetrievalConfig, SemanticChannel,
};
pub use fusion::rrf_merge;
