//! Batch rerank client (HTTP JSON).

use serde::{Deserialize, Serialize};

use crate::error::LlamaResult;

/// Client for the llama-server rerank endpoint.
#[derive(Debug, Clone)]
pub struct RerankClient {
    http: reqwest::Client,
    endpoint: String,
}

/// One rerank result: the original document index and its relevance score.
#[derive(Debug, Clone, Deserialize)]
pub struct RerankItem {
    /// Index into the input documents.
    pub index: usize,
    /// Relevance score assigned by the reranker.
    pub relevance_score: f32,
}

impl RerankClient {
    /// Creates a client targeting the given rerank endpoint.
    #[must_use]
    pub fn new(endpoint: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            endpoint: endpoint.into(),
        }
    }

    /// Reranks `documents` for `query`, returning scored indices.
    ///
    /// # Errors
    /// Returns [`crate::LlamaError`] on HTTP failure or an invalid response body.
    pub async fn rerank(
        &self,
        query: &str,
        documents: &[&str],
        top_n: usize,
    ) -> LlamaResult<Vec<RerankItem>> {
        let body = RerankRequest {
            query,
            documents,
            top_n,
        };
        let response = self
            .http
            .post(&self.endpoint)
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json::<RerankResponse>()
            .await?;

        Ok(response.results)
    }
}

/// Returns whether rerank scores look unusable (empty or all near zero).
///
/// Callers use this to fail open to the pre-rerank ordering.
#[must_use]
pub fn looks_broken(scores: &[RerankItem]) -> bool {
    scores.is_empty()
        || scores
            .iter()
            .all(|score| score.relevance_score.abs() < 1e-10)
}

#[derive(Debug, Serialize)]
struct RerankRequest<'a> {
    query: &'a str,
    documents: &'a [&'a str],
    top_n: usize,
}

#[derive(Debug, Deserialize)]
struct RerankResponse {
    results: Vec<RerankItem>,
}
