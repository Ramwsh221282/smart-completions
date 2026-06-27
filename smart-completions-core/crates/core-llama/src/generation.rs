//! Streaming generation client for FIM/NES via the llama-server SSE endpoint.

use eventsource_stream::Eventsource;
use futures::StreamExt;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::error::{LlamaError, LlamaResult};

/// Client for one llama-server completion endpoint.
#[derive(Debug, Clone)]
pub struct GenerationClient {
    http: reqwest::Client,
    endpoint: String,
}

/// Request body for a streamed completion.
#[derive(Debug, Serialize)]
pub struct GenerationRequest<'a> {
    /// Prompt text.
    pub prompt: &'a str,
    /// Maximum number of tokens to generate.
    pub max_tokens: u32,
    /// Sampling temperature.
    pub temperature: f32,
    /// Whether the server should stream tokens.
    pub stream: bool,
    /// Whether the server may reuse the cached prompt prefix.
    pub cache_prompt: bool,
    /// Stop sequences.
    pub stop: &'a [&'a str],
}

impl GenerationClient {
    /// Creates a client targeting the given completion endpoint.
    #[must_use]
    pub fn new(endpoint: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            endpoint: endpoint.into(),
        }
    }

    /// Streams completion tokens, invoking `on_token` for each one.
    ///
    /// Returns early with `Ok(())` when `cancel` fires.
    ///
    /// # Errors
    /// Returns [`LlamaError`] on HTTP failure, a malformed SSE event, or when
    /// the callback returns an error.
    pub async fn stream_completion<F>(
        &self,
        request: &GenerationRequest<'_>,
        cancel: &CancellationToken,
        mut on_token: F,
    ) -> LlamaResult<()>
    where
        F: FnMut(String) -> LlamaResult<()>,
    {
        let response = self.post_generation(request).await?;
        let mut events = response.bytes_stream().eventsource();

        loop {
            tokio::select! {
                biased;
                () = cancel.cancelled() => return Ok(()),
                maybe_event = events.next() => {
                    let Some(event) = maybe_event else { break };
                    let event = event.map_err(|err| LlamaError::Sse(err.to_string()))?;
                    if let Some(token) = token_from_sse_data(&event.data) {
                        on_token(token)?;
                    }
                }
            }
        }

        Ok(())
    }

    async fn post_generation(
        &self,
        request: &GenerationRequest<'_>,
    ) -> LlamaResult<reqwest::Response> {
        let response = self
            .http
            .post(&self.endpoint)
            .json(request)
            .send()
            .await?
            .error_for_status()?;
        Ok(response)
    }
}

// Accepts the three llama-server / OpenAI-compatible streaming shapes so the
// same client works against `/completion`, `/v1/completions`, and
// `/v1/chat/completions` without the caller knowing which endpoint config picked.
fn token_from_sse_data(data: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(data).ok()?;
    value
        .get("content")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            value
                .pointer("/choices/0/text")
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| {
            value
                .pointer("/choices/0/delta/content")
                .and_then(serde_json::Value::as_str)
        })
        .map(ToOwned::to_owned)
}
