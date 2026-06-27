//! Batch embedding client (HTTP JSON, never SSE).

use serde::{Deserialize, Serialize};

use crate::error::LlamaResult;

/// Client for the llama-server embeddings endpoint.
#[derive(Debug, Clone)]
pub struct EmbeddingClient {
    http: reqwest::Client,
    endpoint: String,
}

impl EmbeddingClient {
    /// Creates a client targeting the given embeddings endpoint.
    #[must_use]
    pub fn new(endpoint: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            endpoint: endpoint.into(),
        }
    }

    /// Embeds a batch, returning vectors ordered by request index.
    ///
    /// # Errors
    /// Returns [`crate::LlamaError`] on HTTP failure or an invalid response body.
    pub async fn embed_batch(&self, input: &[&str], model: &str) -> LlamaResult<Vec<Vec<f32>>> {
        let body = EmbeddingRequest { input, model };
        let response = self
            .http
            .post(&self.endpoint)
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json::<EmbeddingResponse>()
            .await?;

        Ok(ordered_embeddings(response))
    }
}

#[derive(Debug, Serialize)]
struct EmbeddingRequest<'a> {
    input: &'a [&'a str],
    model: &'a str,
}

#[derive(Debug, Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingItem>,
}

#[derive(Debug, Deserialize)]
struct EmbeddingItem {
    index: usize,
    embedding: Vec<f32>,
}

fn ordered_embeddings(response: EmbeddingResponse) -> Vec<Vec<f32>> {
    let mut items = response.data;
    items.sort_by_key(|item| item.index);
    items.into_iter().map(|item| item.embedding).collect()
}
