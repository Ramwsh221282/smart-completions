//! Model modules: one module per model, each owning its own prompt format.
//!
//! Modules never share a god-builder. The registry maps a model id to a
//! static-dispatch enum so routing stays allocation-free. This phase ships the
//! Qwen2.5 FIM format and a Sweep NES skeleton; the remaining models follow on
//! the model-parity phase.

mod qwen25;
mod registry;
mod sweep;
mod traits;

pub use qwen25::Qwen25Module;
pub use registry::{FimModuleKind, NesModuleKind};
pub use sweep::SweepModule;
pub use traits::{FimModelModule, FimRenderInput, GenerationMode, NesModelModule, NesRenderInput};
