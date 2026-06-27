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

fn input<'a>(
    original_window: &'a str,
    current_window: &'a str,
    broad_file_text: &'a str,
    neighbors: &'a [Neighbor],
) -> NesRenderInput<'a> {
    let cursor_byte_offset = current_window
        .strip_suffix('\n')
        .map_or(current_window.len(), str::len);

    NesRenderInput {
        language_id: "typescript",
        file_path: "a.ts",
        original_window,
        current_window,
        window_start_line: 0,
        window_line_count: 1,
        cursor_byte_offset,
        broad_file_text,
        neighbors,
    }
}

#[test]
fn renders_the_original_current_updated_triad_when_no_context_exists() {
    let input = input("let a = 0;\n", "let a = 1;\n", "", &[]);

    let prompt = SweepModule.render_prompt(&input);

    assert_eq!(
        prompt,
        "<|file_sep|>original/a.ts:1:1\nlet a = 0;\n\n<|file_sep|>current/a.ts:1:1\nlet a = 1;<|cursor|>\n\n<|file_sep|>updated/a.ts:1:1\n"
    );
}

#[test]
fn renders_broad_file_and_neighbors_before_the_triad() {
    let neighbors = [neighbor("n.ts", "N")];
    let input = input("OLD", "WIN", "MOD", &neighbors);

    let prompt = SweepModule.render_prompt(&input);

    assert_eq!(
        prompt,
        "<|file_sep|>a.ts\nMOD\n<|file_sep|>n.ts\nN\n<|file_sep|>original/a.ts:1:1\nOLD\n<|file_sep|>current/a.ts:1:1\nWIN<|cursor|>\n<|file_sep|>updated/a.ts:1:1\n"
    );
}

#[test]
fn renders_the_window_range_in_the_triad_headers() {
    let input = NesRenderInput {
        language_id: "typescript",
        file_path: "a.ts",
        original_window: "before",
        current_window: "after",
        window_start_line: 9,
        window_line_count: 3,
        cursor_byte_offset: 2,
        broad_file_text: "",
        neighbors: &[],
    };

    let prompt = SweepModule.render_prompt(&input);

    assert!(prompt.contains("<|file_sep|>original/a.ts:10:12\n"));
    assert!(prompt.contains("<|file_sep|>current/a.ts:10:12\naf<|cursor|>ter\n"));
    assert!(prompt.contains("<|file_sep|>updated/a.ts:10:12\n"));
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
