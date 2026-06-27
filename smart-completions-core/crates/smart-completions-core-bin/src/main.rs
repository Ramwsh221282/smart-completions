//! `smart-completions-core` binary entry point.
//!
//! Boots tracing, then serves the IPC socket through the core application layer:
//! document sync into the shadow store and the FIM pilot route to the
//! llama-server. Shuts down on a shutdown frame or `ctrl_c`.

use std::env;

use anyhow::Result;
use core_llama::GenerationClient;
use tracing::info;

const DEFAULT_FIM_URL: &str = "http://127.0.0.1:8020/completion";

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    run(socket_path_from_args()).await
}

async fn run(socket_path: Option<String>) -> Result<()> {
    match socket_path {
        Some(path) => serve(&path).await,
        None => wait_for_signal().await,
    }
}

async fn serve(path: &str) -> Result<()> {
    let endpoint = fim_endpoint();
    info!(
        socket = path,
        fim = endpoint.as_str(),
        "smart-completions-core listening"
    );

    tokio::select! {
        result = core_app::run(path, GenerationClient::new(endpoint)) => result?,
        () = wait_for_signal_inner() => info!("smart-completions-core interrupted"),
    }

    info!("smart-completions-core shutting down");
    Ok(())
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

fn fim_endpoint() -> String {
    env::var("SMART_COMPLETIONS_CORE_FIM_URL").unwrap_or_else(|_| DEFAULT_FIM_URL.to_owned())
}

fn socket_path_from_args() -> Option<String> {
    let args: Vec<String> = env::args().collect();
    args.iter()
        .position(|arg| arg == "--socket")
        .and_then(|index| args.get(index + 1).cloned())
}
