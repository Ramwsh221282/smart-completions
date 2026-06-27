//! Generates Rust types from the FlatBuffers schemas at build time.
//!
//! Uses the planus codegen libraries directly, so no external `planus` binary
//! has to be installed. Output goes to `OUT_DIR/smart_completions_schema.rs` and
//! is included by the crate's `generated` module.

use std::env;
use std::path::PathBuf;

fn main() {
    print_rerun_hints();
    generate_schema();
}

fn print_rerun_hints() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../../schema/envelope.fbs");
    println!("cargo:rerun-if-changed=../../schema/stream.fbs");
    println!("cargo:rerun-if-changed=../../schema/control.fbs");
}

fn generate_schema() {
    let out_dir = env::var("OUT_DIR").expect("OUT_DIR is set by Cargo");
    let out_path = PathBuf::from(out_dir).join("smart_completions_schema.rs");

    let inputs = [
        PathBuf::from("../../schema/envelope.fbs"),
        PathBuf::from("../../schema/stream.fbs"),
        PathBuf::from("../../schema/control.fbs"),
    ];

    let declarations = planus_translation::translate_files(&inputs)
        .expect("planus failed to translate the FlatBuffers schemas");
    let code = planus_codegen::generate_rust(&declarations, true)
        .expect("planus failed to generate Rust from the schemas");

    std::fs::write(&out_path, code).expect("failed to write the generated schema");
}
