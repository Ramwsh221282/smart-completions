//! Spawns and runs a streamed FIM completion, emitting frames as tokens arrive.

use core_ipc::ServerFrame;
use core_llama::{GenerationClient, GenerationRequest, LlamaError, LlamaResult};
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

/// Spawns a detached task that streams the completion into the frame channel.
pub(crate) fn spawn_fim_completion(params: FimCompletion) {
    tokio::spawn(run_fim_completion(params));
}

async fn run_fim_completion(params: FimCompletion) {
    let request = GenerationRequest {
        prompt: &params.prompt,
        max_tokens: params.max_tokens,
        temperature: 0.0,
        stream: true,
        cache_prompt: true,
        stop: params.stop,
    };

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
