//! Request routing and per-request cancellation for the core.
//!
//! The dispatcher resolves the model module for a request and owns the
//! cancellation token registry. Retrieval and generation are wired in on their
//! own phases; today routing returns a started/skipped decision.

mod cancellation;
mod dispatcher;

pub use cancellation::CancellationRegistry;
pub use dispatcher::{DispatchRequest, DispatchResponse, Dispatcher};
