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
const DEFAULT_NES_URL: &str = "http://127.0.0.1:8010/completion";

#[tokio::main]
async fn main() -> Result<()> {
    if wants_version() {
        println!("smart-completions-core {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    init_tracing();
    run(socket_path_from_args()).await
}

fn wants_version() -> bool {
    env::args()
        .skip(1)
        .any(|arg| arg == "--version" || arg == "-V")
}

async fn run(socket_path: Option<String>) -> Result<()> {
    match socket_path {
        Some(path) => serve(&path).await,
        None => wait_for_signal().await,
    }
}

async fn serve(path: &str) -> Result<()> {
    let fim = fim_endpoint();
    let nes = nes_endpoint();
    info!(
        socket = path,
        fim = fim.as_str(),
        nes = nes.as_str(),
        "smart-completions-core listening"
    );

    tokio::select! {
        result = core_app::run(path, GenerationClient::new(fim), GenerationClient::new(nes)) => result?,
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

fn nes_endpoint() -> String {
    env::var("SMART_COMPLETIONS_CORE_NES_URL").unwrap_or_else(|_| DEFAULT_NES_URL.to_owned())
}

fn socket_path_from_args() -> Option<String> {
    let args: Vec<String> = env::args().collect();
    args.iter()
        .position(|arg| arg == "--socket")
        .and_then(|index| args.get(index + 1).cloned())
}
