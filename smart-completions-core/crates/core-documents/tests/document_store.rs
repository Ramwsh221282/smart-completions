//! Integration tests for the shadow document store.

use core_documents::{
    CoreDocumentStore, DocumentContentChange, DocumentError, InitialDocumentSnapshot,
    OriginalWindowSource, SweepOriginalContext, SweepWindowLayout,
};
use core_edit_history::RecentEdit;
use core_types::{FileMode, Position, Range};

fn snapshot(text: &str) -> InitialDocumentSnapshot {
    snapshot_with_mode(text, FileMode::Code)
}

fn snapshot_with_mode(text: &str, file_mode: FileMode) -> InitialDocumentSnapshot {
    InitialDocumentSnapshot {
        uri: "file:///a.ts".to_string(),
        version: 1,
        language_id: "typescript".to_string(),
        file_path: Some("a.ts".to_string()),
        file_mode,
        text: text.to_string(),
    }
}

#[test]
fn applies_monaco_content_change_and_splits_prefix_suffix() {
    let mut store = CoreDocumentStore::new();
    store.upsert_initial_snapshot(snapshot("const a = 1;\n"));

    store
        .apply_changes(
            "file:///a.ts",
            1,
            2,
            &[DocumentContentChange {
                range: Range {
                    start_line: 0,
                    start_col: 10,
                    end_line: 0,
                    end_col: 11,
                },
                range_length: 1,
                inserted_text: "2".to_string(),
            }],
        )
        .unwrap();

    let (prefix, suffix) = store
        .prefix_suffix_at(
            "file:///a.ts",
            2,
            Position {
                line: 0,
                column: 11,
                offset: 0,
            },
        )
        .unwrap();

    assert_eq!(prefix, "const a = 2");
    assert_eq!(suffix, ";\n");
}

#[test]
fn rejects_changes_when_base_version_does_not_match() {
    let mut store = CoreDocumentStore::new();
    store.upsert_initial_snapshot(snapshot("let x = 0;\n"));

    let result = store.apply_changes("file:///a.ts", 5, 6, &[]);

    assert!(matches!(
        result,
        Err(DocumentError::VersionMismatch {
            expected: 5,
            actual: 1,
            ..
        })
    ));
}

#[test]
fn reports_missing_document_before_any_snapshot() {
    let store = CoreDocumentStore::new();

    let result = store.text_at("file:///ghost.ts", 1);

    assert!(matches!(result, Err(DocumentError::MissingDocument { .. })));
}

#[test]
fn applies_utf16_changes_for_astral_symbols() {
    let mut store = CoreDocumentStore::new();
    store.upsert_initial_snapshot(snapshot("a😀b\n"));

    store
        .apply_changes(
            "file:///a.ts",
            1,
            2,
            &[DocumentContentChange {
                range: Range {
                    start_line: 0,
                    start_col: 1,
                    end_line: 0,
                    end_col: 3,
                },
                range_length: 2,
                inserted_text: "z".to_string(),
            }],
        )
        .unwrap();

    assert_eq!(store.text_at("file:///a.ts", 2).unwrap(), "azb\n");
}

#[test]
fn resolves_cursor_offset_in_utf16_code_units() {
    let mut store = CoreDocumentStore::new();
    store.upsert_initial_snapshot(snapshot("a😀b\n"));

    let (prefix, suffix) = store
        .prefix_suffix_at(
            "file:///a.ts",
            1,
            Position {
                line: 99,
                column: 99,
                offset: 3,
            },
        )
        .unwrap();

    assert_eq!(prefix, "a😀");
    assert_eq!(suffix, "b\n");
}

#[test]
fn rejects_cursor_inside_utf16_surrogate_pair() {
    let mut store = CoreDocumentStore::new();
    store.upsert_initial_snapshot(snapshot("a😀b\n"));

    let result = store.prefix_suffix_at(
        "file:///a.ts",
        1,
        Position {
            line: 0,
            column: 0,
            offset: 2,
        },
    );

    assert!(matches!(result, Err(DocumentError::InvalidRange { .. })));
}

#[test]
fn rejects_changes_when_range_length_disagrees_with_utf16_span() {
    let mut store = CoreDocumentStore::new();
    store.upsert_initial_snapshot(snapshot("a😀b\n"));

    let result = store.apply_changes(
        "file:///a.ts",
        1,
        2,
        &[DocumentContentChange {
            range: Range {
                start_line: 0,
                start_col: 1,
                end_line: 0,
                end_col: 3,
            },
            range_length: 1,
            inserted_text: "z".to_string(),
        }],
    );

    assert!(matches!(result, Err(DocumentError::InvalidRange { .. })));
    assert_eq!(store.text_at("file:///a.ts", 1).unwrap(), "a😀b\n");
}

#[test]
fn current_window_uses_fixed_lines_for_code_buffers() {
    let mut store = CoreDocumentStore::new();
    store.upsert_initial_snapshot(snapshot("l0\nl1😀\nl2\nl3\nl4"));

    let window = store
        .current_window_at(
            "file:///a.ts",
            1,
            Position {
                line: 99,
                column: 99,
                offset: 7,
            },
            1,
            1,
        )
        .unwrap();

    assert_eq!(window.text, "l0\nl1😀\nl2");
    assert_eq!(window.start_line, 0);
    assert_eq!(window.line_count, 3);
    assert_eq!(window.cursor_byte_offset, 9);
}

#[test]
fn current_window_expands_to_paragraph_for_prose_buffers() {
    let mut store = CoreDocumentStore::new();
    store.upsert_initial_snapshot(snapshot_with_mode(
        "title\n\nfirst line\nsecond line\nthird line\n\nfooter",
        FileMode::Prose,
    ));

    let window = store
        .current_window_at(
            "file:///a.ts",
            1,
            Position {
                line: 3,
                column: 0,
                offset: 0,
            },
            0,
            0,
        )
        .unwrap();

    assert_eq!(window.text, "first line\nsecond line\nthird line");
    assert_eq!(window.start_line, 2);
    assert_eq!(window.line_count, 3);
    assert_eq!(window.cursor_byte_offset, 11);
}

#[test]
fn broad_window_returns_centered_line_slice() {
    let mut store = CoreDocumentStore::new();
    store.upsert_initial_snapshot(snapshot("l0\nl1\nl2\nl3\nl4\nl5"));

    let window = store
        .broad_window_at(
            "file:///a.ts",
            1,
            Position {
                line: 3,
                column: 0,
                offset: 0,
            },
            3,
        )
        .unwrap();

    assert_eq!(window.text, "l2\nl3\nl4");
    assert_eq!(window.start_line, 2);
}

#[test]
fn sweep_snapshot_uses_pre_edit_snapshot_before_diff_fallback() {
    let mut store = CoreDocumentStore::new();
    store.upsert_initial_snapshot(snapshot("const value = 2;\nnext();"));
    let recent_edits = [RecentEdit {
        uri: "file:///a.ts".to_string(),
        unified_diff: "--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-const value = 1;\n+const value = 2;"
            .to_string(),
        timestamp: 1,
    }];

    let snapshot = store
        .sweep_snapshot_at(
            "file:///a.ts",
            1,
            Position {
                line: 0,
                column: 12,
                offset: 12,
            },
            SweepWindowLayout {
                before: 0,
                after: 1,
                broad: 4,
            },
            SweepOriginalContext {
                pre_edit_text: Some("const value = 1;\nnext();"),
                recent_edits: &recent_edits,
            },
        )
        .unwrap();

    assert_eq!(snapshot.current.text, "const value = 2;\nnext();");
    assert_eq!(snapshot.original.as_ref(), "const value = 1;\nnext();");
    assert_eq!(snapshot.original_source, OriginalWindowSource::Snapshot);
    assert_eq!(snapshot.broad.text, "const value = 2;\nnext();");
}

#[test]
fn sweep_snapshot_reconstructs_original_window_from_recent_edits() {
    let mut store = CoreDocumentStore::new();
    store.upsert_initial_snapshot(snapshot("const value = 2;"));
    let recent_edits = [RecentEdit {
        uri: "file:///a.ts".to_string(),
        unified_diff: "--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-const value = 1;\n+const value = 2;"
            .to_string(),
        timestamp: 1,
    }];

    let snapshot = store
        .sweep_snapshot_at(
            "file:///a.ts",
            1,
            Position {
                line: 0,
                column: 12,
                offset: 12,
            },
            SweepWindowLayout {
                before: 0,
                after: 0,
                broad: 3,
            },
            SweepOriginalContext {
                pre_edit_text: None,
                recent_edits: &recent_edits,
            },
        )
        .unwrap();

    assert_eq!(snapshot.original.as_ref(), "const value = 1;");
    assert_eq!(
        snapshot.original_source,
        OriginalWindowSource::Reconstructed
    );
}

#[test]
fn sweep_snapshot_falls_back_to_current_window_without_pre_edit_state() {
    let mut store = CoreDocumentStore::new();
    store.upsert_initial_snapshot(snapshot("const value = 2;"));

    let snapshot = store
        .sweep_snapshot_at(
            "file:///a.ts",
            1,
            Position {
                line: 0,
                column: 12,
                offset: 12,
            },
            SweepWindowLayout {
                before: 0,
                after: 0,
                broad: 3,
            },
            SweepOriginalContext {
                pre_edit_text: None,
                recent_edits: &[],
            },
        )
        .unwrap();

    assert_eq!(snapshot.original.as_ref(), snapshot.current.text);
    assert_eq!(
        snapshot.original_source,
        OriginalWindowSource::CurrentFallback
    );
}
