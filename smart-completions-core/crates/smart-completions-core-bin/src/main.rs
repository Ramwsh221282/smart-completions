//! `smart-completions-core` binary entry point.
//!
//! Boots tracing, parses the socket argument and keeps the process alive until
//! a shutdown signal. The interprocess server loop and dispatcher wiring are
//! added on the IPC schema phase; this entry point validates spawn, supervision
//! and packaging end to end.

use std::env;

use anyhow::Result;
use core_documents::CoreDocumentStore;
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    run(socket_path_from_args()).await
}

async fn run(socket_path: Option<String>) -> Result<()> {
    let store = CoreDocumentStore::new();

    info!(
        socket = socket_path.as_deref().unwrap_or("<none>"),
        documents = store.len(),
        "smart-completions-core started"
    );

    tokio::signal::ctrl_c().await?;
    info!("smart-completions-core shutting down");
    Ok(())
}

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

fn socket_path_from_args() -> Option<String> {
    let args: Vec<String> = env::args().collect();
    args.iter()
        .position(|arg| arg == "--socket")
        .and_then(|index| args.get(index + 1).cloned())
}
