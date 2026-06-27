//! Golden prompt tests for the Qwen2.5 FIM module.

use core_models::{FimModelModule, FimModuleKind, FimRenderInput, GenerationMode};
use core_types::{Neighbor, Range};

fn neighbor(path: &str, text: &str) -> Neighbor {
    Neighbor {
        id: path.to_string(),
        file_path: path.to_string(),
        range: Range {
            start_line: 0,
            start_col: 0,
            end_line: 1,
            end_col: 0,
        },
        text: text.to_string(),
        score: 0.0,
    }
}

fn input<'a>(prefix: &'a str, suffix: &'a str, neighbors: &'a [Neighbor]) -> FimRenderInput<'a> {
    FimRenderInput {
        language_id: "typescript",
        file_path: "a.ts",
        prefix,
        suffix,
        neighbors,
        generation_mode: GenerationMode::Line,
    }
}

#[test]
fn renders_bare_fim_prompt_without_repo_context() {
    let module = FimModuleKind::by_model_id("qwen2.5-coder").unwrap();

    let prompt = module.render_prompt(&input("const x = ", ";\n", &[]));

    assert_eq!(
        prompt,
        "<|file_sep|>a.ts\n<|fim_prefix|>const x = <|fim_suffix|>;\n<|fim_middle|>"
    );
}

#[test]
fn renders_repo_context_before_the_current_file() {
    let neighbors = [neighbor("b.ts", "export const b = 1;")];
    let module = FimModuleKind::by_model_id("qwen2.5-coder").unwrap();

    let prompt = module.render_prompt(&input("const x = ", ";\n", &neighbors));

    assert_eq!(
        prompt,
        "<|repo_name|>workspace\n<|file_sep|>b.ts\nexport const b = 1;\n<|file_sep|>a.ts\n<|fim_prefix|>const x = <|fim_suffix|>;\n<|fim_middle|>"
    );
}

#[test]
fn max_tokens_follow_generation_mode() {
    let module = FimModuleKind::by_model_id("omnicoder").unwrap();

    assert_eq!(module.max_tokens(GenerationMode::Line), 48);
    assert_eq!(module.max_tokens(GenerationMode::Multiline), 160);
    assert_eq!(module.max_tokens(GenerationMode::Block), 384);
}

#[test]
fn unknown_model_id_does_not_resolve() {
    assert!(FimModuleKind::by_model_id("ghost-model").is_none());
}
