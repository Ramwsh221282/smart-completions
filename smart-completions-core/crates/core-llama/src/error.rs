//! Error types shared by the llama-server clients.

/// Result alias for llama client operations.
pub type LlamaResult<T> = Result<T, LlamaError>;

/// Failures from the generation, embedding, and rerank clients.
#[derive(Debug, thiserror::Error)]
pub enum LlamaError {
    /// Transport failure or non-success HTTP status.
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),

    /// A server-sent-events stream produced a malformed event.
    #[error("sse error: {0}")]
    Sse(String),

    /// A token callback returned an error and aborted streaming.
    #[error("callback error: {0}")]
    Callback(String),
}
