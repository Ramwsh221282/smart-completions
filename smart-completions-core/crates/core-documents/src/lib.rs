//! Shadow document store.
//!
//! Node sends an initial snapshot once per document, then only Monaco content
//! changes. The core keeps the authoritative text and derives prefix, suffix
//! and windows itself, so the IPC boundary never ships per-request prefixes.

mod change;
mod error;
mod store;

pub use change::{DocumentContentChange, InitialDocumentSnapshot};
pub use error::{DocumentError, DocumentResult};
pub use store::{
    BroadDocumentWindow, CoreDocumentStore, CurrentDocumentWindow, OriginalWindowSource,
    SweepDocumentSnapshot, SweepOriginalContext, SweepWindowLayout,
};
