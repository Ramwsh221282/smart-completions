//! Spawns and runs streamed FIM/NES completions.

use core_ipc::ServerFrame;
use core_llama::{GenerationClient, GenerationRequest, LlamaError, LlamaResult};
use core_models::{NesModelModule, NesModuleKind};
use core_types::Range;
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

/// Owned inputs for one streamed FIM completion task.
pub(crate) struct FimCompletion {
    /// Generation client targeting the FIM llama-server.
    pub client: GenerationClient,
    /// Rendered prompt.
    pub prompt: String,
    /// Output token budget.
    pub max_tokens: u32,
    /// Model stop tokens.
    pub stop: &'static [&'static str],
    /// Cancellation token for this request.
    pub cancel: CancellationToken,
    /// Channel that carries server frames back to the connection.
    pub out: UnboundedSender<ServerFrame>,
    /// Request id for frame correlation.
    pub request_id: u64,
}

/// Owned inputs for one NES completion task that resolves to an edit.
pub(crate) struct NesCompletion {
    /// Generation client targeting the NES llama-server.
    pub client: GenerationClient,
    /// Rendered prompt.
    pub prompt: String,
    /// Output token budget.
    pub max_tokens: u32,
    /// Model stop tokens.
    pub stop: &'static [&'static str],
    /// Cancellation token for this request.
    pub cancel: CancellationToken,
    /// Channel that carries server frames back to the connection.
    pub out: UnboundedSender<ServerFrame>,
    /// Request id for frame correlation.
    pub request_id: u64,
    /// NES module that parses the raw response.
    pub module: NesModuleKind,
    /// Full replacement range for the current editable window.
    pub range: Range,
}

/// Spawns a detached task that streams the completion into the frame channel.
pub(crate) fn spawn_fim_completion(params: FimCompletion) {
    tokio::spawn(run_fim_completion(params));
}

/// Spawns a detached task that resolves a NES request into one edit frame.
pub(crate) fn spawn_nes_completion(params: NesCompletion) {
    tokio::spawn(run_nes_completion(params));
}

async fn run_fim_completion(params: FimCompletion) {
    let request = generation_request(&params.prompt, params.max_tokens, params.stop);

    let out = params.out.clone();
    let request_id = params.request_id;
    let result = params
        .client
        .stream_completion(&request, &params.cancel, |text| {
            emit_token(&out, request_id, text)
        })
        .await;

    finish(&params.out, request_id, result);
}

async fn run_nes_completion(params: NesCompletion) {
    let request = generation_request(&params.prompt, params.max_tokens, params.stop);
    let mut raw = String::new();
    let request_id = params.request_id;
    let result = params
        .client
        .stream_completion(&request, &params.cancel, |text| {
            raw.push_str(&text);
            Ok(())
        })
        .await;

    finish_nes(&params, request_id, result, &raw);
}

fn generation_request<'a>(
    prompt: &'a str,
    max_tokens: u32,
    stop: &'a [&'a str],
) -> GenerationRequest<'a> {
    GenerationRequest {
        prompt,
        max_tokens,
        temperature: 0.0,
        stream: true,
        cache_prompt: true,
        stop,
    }
}

fn emit_token(
    out: &UnboundedSender<ServerFrame>,
    request_id: u64,
    text: String,
) -> LlamaResult<()> {
    out.send(ServerFrame::Token { request_id, text })
        .map_err(|err| LlamaError::Callback(err.to_string()))
}

fn finish(out: &UnboundedSender<ServerFrame>, request_id: u64, result: LlamaResult<()>) {
    let frame = match result {
        Ok(()) => ServerFrame::Done { request_id },
        Err(err) => ServerFrame::Error {
            request_id,
            message: err.to_string(),
        },
    };
    let _ = out.send(frame);
}

fn finish_nes(params: &NesCompletion, request_id: u64, result: LlamaResult<()>, raw: &str) {
    match result {
        Ok(()) => {
            if !params.cancel.is_cancelled() {
                emit_nes_edit(params, request_id, raw);
            }
            let _ = params.out.send(ServerFrame::Done { request_id });
        }
        Err(err) => {
            let _ = params.out.send(ServerFrame::Error {
                request_id,
                message: err.to_string(),
            });
        }
    }
}

fn emit_nes_edit(params: &NesCompletion, request_id: u64, raw: &str) {
    let Some(new_text) = params.module.parse_response(raw) else {
        return;
    };

    let _ = params.out.send(ServerFrame::Edit {
        request_id,
        range: params.range,
        new_text,
        jump: None,
    });
}
