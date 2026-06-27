use std::collections::HashMap;

use core_types::RequestId;
use tokio_util::sync::CancellationToken;

/// Tracks one cancellation token per in-flight request.
///
/// Starting a request that is already tracked cancels the previous one, which
/// matches the editor's "supersede the stale completion" behaviour.
#[derive(Debug, Default)]
pub struct CancellationRegistry {
    tokens: HashMap<RequestId, CancellationToken>,
}

impl CancellationRegistry {
    /// Creates an empty registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts tracking a request, cancelling any previous one with the same id.
    pub fn start(&mut self, request_id: RequestId) -> CancellationToken {
        self.cancel(request_id);
        let token = CancellationToken::new();
        self.tokens.insert(request_id, token.clone());
        token
    }

    /// Cancels and forgets a tracked request.
    pub fn cancel(&mut self, request_id: RequestId) {
        if let Some(token) = self.tokens.remove(&request_id) {
            token.cancel();
        }
    }

    /// Forgets a finished request without cancelling it.
    pub fn finish(&mut self, request_id: RequestId) {
        self.tokens.remove(&request_id);
    }

    /// Returns how many requests are currently tracked.
    #[must_use]
    pub fn len(&self) -> usize {
        self.tokens.len()
    }

    /// Returns whether no requests are tracked.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }
}
