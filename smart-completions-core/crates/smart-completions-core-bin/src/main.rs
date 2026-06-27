//! `smart-completions-core` binary entry point.
//!
//! Boots tracing, then serves the IPC socket, applying document sync to the
//! shadow store and routing completion requests through the dispatcher.
//! Generation streaming is wired on the llama-client phase; today a routed
//! request answers with a `Done`/`Error` frame.

mod handler;

use std::env;

use anyhow::Result;
use tracing::info;

use crate::handler::CoreFrameHandler;

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    run(socket_path_from_args()).await
}

async fn run(socket_path: Option<String>) -> Result<()> {
    let mut handler = CoreFrameHandler::new();

    match socket_path {
        Some(path) => serve(&path, &mut handler).await,
        None => wait_for_signal().await,
    }
}

#[cfg(unix)]
async fn serve(path: &str, handler: &mut CoreFrameHandler) -> Result<()> {
    info!(socket = path, "smart-completions-core listening");

    tokio::select! {
        result = core_ipc::serve_unix_socket(std::path::Path::new(path), handler) => result?,
        () = wait_for_signal_inner() => info!("smart-completions-core interrupted"),
    }

    info!("smart-completions-core shutting down");
    Ok(())
}

#[cfg(not(unix))]
async fn serve(_path: &str, _handler: &mut CoreFrameHandler) -> Result<()> {
    // The Windows named-pipe listener lands on the cross-platform phase.
    wait_for_signal().await
}

async fn wait_for_signal() -> Result<()> {
    wait_for_signal_inner().await;
    info!("smart-completions-core shutting down");
    Ok(())
}

async fn wait_for_signal_inner() {
    let _ = tokio::signal::ctrl_c().await;
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
