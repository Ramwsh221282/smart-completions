//! Shared retrieval primitives.
//!
//! Cross-channel fusion uses reciprocal rank fusion. Channels are dispatched
//! through an enum so the hot path never pays for `async_trait`/`Box<dyn>`.

mod channels;
mod fusion;

pub use channels::{
    ChannelId, ChannelInput, FuzzyFimChannel, FuzzyNesChannel, GraphChannel, RetrievalChannelKind,
    RetrievalConfig, RetrievalDocument, SemanticChannel,
};
pub use fusion::rrf_merge;
