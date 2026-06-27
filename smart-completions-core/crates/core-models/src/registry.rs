//! Model id to static-dispatch module mapping.
//!
//! Only the modules implemented this phase are wired in (Qwen2.5 FIM, Sweep
//! NES). Remaining models are added on the model-parity phase by extending
//! these enums.

use crate::qwen25::Qwen25Module;
use crate::sweep::SweepModule;
use crate::traits::{
    FimModelModule, FimRenderInput, GenerationMode, NesModelModule, NesRenderInput,
};

/// Static-dispatch set of FIM model modules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FimModuleKind {
    /// Qwen2.5 Coder family.
    Qwen25(Qwen25Module),
}

impl FimModuleKind {
    /// Resolves a model id to a FIM module.
    #[must_use]
    pub fn by_model_id(model_id: &str) -> Option<Self> {
        match model_id {
            "qwen2.5-coder" | "omnicoder" => Some(Self::Qwen25(Qwen25Module)),
            _ => None,
        }
    }
}

impl FimModelModule for FimModuleKind {
    fn model_id(&self) -> &'static str {
        match self {
            Self::Qwen25(module) => module.model_id(),
        }
    }

    fn context_tokens(&self) -> usize {
        match self {
            Self::Qwen25(module) => module.context_tokens(),
        }
    }

    fn embedder_id(&self) -> &'static str {
        match self {
            Self::Qwen25(module) => module.embedder_id(),
        }
    }

    fn special_tokens(&self) -> &'static [&'static str] {
        match self {
            Self::Qwen25(module) => module.special_tokens(),
        }
    }

    fn stop_tokens(&self) -> &'static [&'static str] {
        match self {
            Self::Qwen25(module) => module.stop_tokens(),
        }
    }

    fn max_tokens(&self, mode: GenerationMode) -> u32 {
        match self {
            Self::Qwen25(module) => module.max_tokens(mode),
        }
    }

    fn render_prompt(&self, input: &FimRenderInput<'_>) -> String {
        match self {
            Self::Qwen25(module) => module.render_prompt(input),
        }
    }
}

/// Static-dispatch set of NES model modules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NesModuleKind {
    /// Sweep next-edit-suggestion family.
    Sweep(SweepModule),
}

impl NesModuleKind {
    /// Resolves a model id to a NES module.
    #[must_use]
    pub fn by_model_id(model_id: &str) -> Option<Self> {
        match model_id {
            "sweep-default" | "sweep-small" => Some(Self::Sweep(SweepModule)),
            _ => None,
        }
    }
}

impl NesModelModule for NesModuleKind {
    fn model_id(&self) -> &'static str {
        match self {
            Self::Sweep(module) => module.model_id(),
        }
    }

    fn context_tokens(&self) -> usize {
        match self {
            Self::Sweep(module) => module.context_tokens(),
        }
    }

    fn stop_tokens(&self) -> &'static [&'static str] {
        match self {
            Self::Sweep(module) => module.stop_tokens(),
        }
    }

    fn render_prompt(&self, input: &NesRenderInput<'_>) -> String {
        match self {
            Self::Sweep(module) => module.render_prompt(input),
        }
    }

    fn parse_response(&self, raw: &str) -> Option<String> {
        match self {
            Self::Sweep(module) => module.parse_response(raw),
        }
    }
}
