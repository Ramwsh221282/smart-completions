# smart-completions-core — build regulation

Rust core lives inside the `smart-completions` extension and belongs to this
repository. It is built into a single binary that is copied into
`resources/bin/` for packaging. Rust sources and `target/` never ship in the
npm/electron artifact.

## Mandatory commands (run from `smart-completions-core/`)

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --release -p smart-completions-core-bin
cargo bloat --release --crates
```

Size report:

```bash
mkdir -p target/reports
cargo bloat --release --crates > target/reports/cargo-bloat-crates.txt
```

## Release profile

Production artifacts use the main `release` profile (`lto = true`,
`opt-level = "s"`, `codegen-units = 1`, `panic = "abort"`, `strip = true`).
`release-thin` is a local diagnostic profile only.

## Phased migration

Crates are added per `docs/rust/docs/implementation.md`. Each phase must stay
buildable and testable. Heavy native/network crates (lancedb, tantivy,
rusqlite, tree-sitter, tokenizers, reqwest, interprocess, planus) are pulled in
on the phase that needs them, behind the TypeScript feature-flag fallback.
