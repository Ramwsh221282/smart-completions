use core_types::{CompletionMode, DocumentVersion, RequestId};
use tokio_util::sync::CancellationToken;

use crate::cancellation::CancellationRegistry;

/// A routed completion request as the dispatcher sees it.
#[derive(Debug, Clone)]
pub struct DispatchRequest {
    /// Identity used for cancellation and stream correlation.
    pub request_id: RequestId,
    /// Which pipeline the request targets.
    pub mode: CompletionMode,
    /// Model id selecting the concrete model module.
    pub model_id: String,
    /// Document the request is anchored to.
    pub uri: String,
    /// Document version the request was built against.
    pub version: DocumentVersion,
}

/// Outcome of dispatching a request.
#[derive(Debug, PartialEq, Eq)]
pub enum DispatchResponse {
    /// The request was accepted and a pipeline run started.
    Started,
    /// The request was skipped before doing any work.
    Skipped {
        /// Human-readable reason for the skip.
        reason: String,
    },
}

/// Routes requests to the right pipeline and owns per-request cancellation.
#[derive(Debug, Default)]
pub struct Dispatcher {
    cancellation: CancellationRegistry,
}

impl Dispatcher {
    /// Creates a dispatcher with an empty cancellation registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Dispatches a request, registering and clearing its cancellation token.
    #[expect(
        clippy::unused_async,
        reason = "dispatch awaits retrieval and generation once those phases land"
    )]
    pub async fn dispatch(&mut self, request: DispatchRequest) -> DispatchResponse {
        let cancel = self.cancellation.start(request.request_id);
        let response = route(&request, &cancel);
        self.cancellation.finish(request.request_id);
        response
    }

    /// Cancels an in-flight request by id.
    pub fn cancel(&mut self, request_id: RequestId) {
        self.cancellation.cancel(request_id);
    }
}

fn route(request: &DispatchRequest, cancel: &CancellationToken) -> DispatchResponse {
    if cancel.is_cancelled() {
        return skipped("cancelled before dispatch");
    }

    match request.mode {
        CompletionMode::Fim => route_fim(request),
        CompletionMode::Nes => route_nes(request),
    }
}

fn route_fim(_request: &DispatchRequest) -> DispatchResponse {
    DispatchResponse::Started
}

fn route_nes(_request: &DispatchRequest) -> DispatchResponse {
    DispatchResponse::Started
}

fn skipped(reason: impl Into<String>) -> DispatchResponse {
    DispatchResponse::Skipped {
        reason: reason.into(),
    }
}
