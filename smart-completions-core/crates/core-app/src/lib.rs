//! Core application layer: connection serving and the FIM pilot route.
//!
//! Node syncs documents and asks for completions; the handler builds the prompt
//! from the shadow store, calls the llama-server generation client, and streams
//! `Token`/`Done` frames back. Only the Qwen2.5 FIM path is routed for now; the
//! TypeScript services remain the fallback for everything else.

mod completion;
mod handler;
mod server;

pub use handler::{CoreFrameHandler, HandleOutcome};
pub use server::run;
