//! Integration tests for the shadow document store.

use core_documents::{
    CoreDocumentStore, DocumentContentChange, DocumentError, InitialDocumentSnapshot,
};
use core_types::{FileMode, Position, Range};

fn snapshot(text: &str) -> InitialDocumentSnapshot {
    InitialDocumentSnapshot {
        uri: "file:///a.ts".to_string(),
        version: 1,
        language_id: "typescript".to_string(),
        file_path: Some("a.ts".to_string()),
        file_mode: FileMode::Code,
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
