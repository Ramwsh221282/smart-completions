//! llama-server clients.
//!
//! Generation (FIM/NES) streams tokens over SSE. Embeddings and rerank are
//! batch HTTP JSON, never SSE. External-service failures are surfaced as errors
//! so callers can fail open to a lexical or non-reranked path.

pub mod embedding;
pub mod error;
pub mod generation;
pub mod rerank;

pub use embedding::EmbeddingClient;
pub use error::{LlamaError, LlamaResult};
pub use generation::{GenerationClient, GenerationRequest};
pub use rerank::{looks_broken, RerankClient, RerankItem};
