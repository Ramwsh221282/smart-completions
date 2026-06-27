//! Integration tests for Rust-side edit-history helpers.

use core_edit_history::{
    format_sweep_unified_diff, reconstruct_original_window, slice_line_window, RecentEdit,
};

#[test]
fn slices_a_line_window_from_snapshot_text() {
    let window = slice_line_window("title\r\n\r\nfirst\r\nsecond\r\nthird", 2, 2);

    assert_eq!(window, "first\nsecond");
}

#[test]
fn formats_a_compact_unified_diff() {
    let diff = format_sweep_unified_diff("file:///src/a.ts", "const a = 1;\n", "const a = 2;\n");

    assert_eq!(
        diff,
        "--- file:///src/a.ts\n+++ file:///src/a.ts\n@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;"
    );
}

#[test]
fn reconstructs_the_latest_intersecting_original_window() {
    let reconstructed = reconstruct_original_window(
        "const value = 3;",
        0,
        "file:///src/a.ts",
        &[
            RecentEdit {
                uri: "file:///src/a.ts".to_string(),
                unified_diff:
                    "--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-const value = 1;\n+const value = 2;"
                        .to_string(),
                timestamp: 1,
            },
            RecentEdit {
                uri: "file:///src/a.ts".to_string(),
                unified_diff:
                    "--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-const value = 2;\n+const value = 3;"
                        .to_string(),
                timestamp: 2,
            },
        ],
    );

    assert_eq!(reconstructed, Some("const value = 2;".to_string()));
}

#[test]
fn reconstruction_ignores_non_matching_edits() {
    let reconstructed = reconstruct_original_window(
        "const value = 2;",
        0,
        "file:///src/a.ts",
        &[RecentEdit {
            uri: "file:///src/other.ts".to_string(),
            unified_diff:
                "--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-const value = 1;\n+const value = 2;"
                    .to_string(),
            timestamp: 1,
        }],
    );

    assert_eq!(reconstructed, None);
}

#[test]
fn reconstruction_requires_the_current_window_to_match_updated_lines() {
    let reconstructed = reconstruct_original_window(
        "const value = 9;",
        0,
        "file:///src/a.ts",
        &[RecentEdit {
            uri: "file:///src/a.ts".to_string(),
            unified_diff:
                "--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-const value = 1;\n+const value = 2;"
                    .to_string(),
            timestamp: 1,
        }],
    );

    assert_eq!(reconstructed, None);
}
