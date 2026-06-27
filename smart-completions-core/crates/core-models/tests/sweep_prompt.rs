//! Prompt and parser tests for the Sweep NES module.

use core_models::{NesModelModule, NesModuleKind, NesRenderInput, SweepModule};
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

#[test]
fn renders_only_the_current_window_block_when_no_context() {
    let input = NesRenderInput {
        language_id: "typescript",
        file_path: "a.ts",
        current_window: "let a = 1;\n",
        broad_file_text: "",
        neighbors: &[],
    };

    let prompt = SweepModule.render_prompt(&input);

    assert_eq!(prompt, "<|file_sep|>current/a.ts\nlet a = 1;\n");
}

#[test]
fn renders_broad_file_and_neighbors_before_current_window() {
    let neighbors = [neighbor("n.ts", "N")];
    let input = NesRenderInput {
        language_id: "typescript",
        file_path: "a.ts",
        current_window: "WIN",
        broad_file_text: "MOD",
        neighbors: &neighbors,
    };

    let prompt = SweepModule.render_prompt(&input);

    assert_eq!(
        prompt,
        "<|file_sep|>a.ts\nMOD\n<|file_sep|>n.ts\nN\n<|file_sep|>current/a.ts\nWIN"
    );
}

#[test]
fn parse_response_returns_none_for_no_edits_sentinel() {
    assert_eq!(SweepModule.parse_response("NO_EDITS"), None);
}

#[test]
fn parse_response_strips_cursor_and_cuts_at_stop_token() {
    let parsed = SweepModule.parse_response("  hello <|cursor|>world  <|file_sep|>tail");

    assert_eq!(parsed, Some("hello world".to_string()));
}

#[test]
fn parse_response_returns_none_for_blank_output() {
    assert_eq!(SweepModule.parse_response("   "), None);
}

#[test]
fn registry_resolves_sweep_model_ids() {
    assert!(NesModuleKind::by_model_id("sweep-default").is_some());
    assert!(NesModuleKind::by_model_id("sweep-small").is_some());
    assert!(NesModuleKind::by_model_id("zeta-2.1").is_none());
}
