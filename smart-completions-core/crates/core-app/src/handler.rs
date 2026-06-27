//! Client-frame handler: document sync plus the FIM pilot route.

use core_dispatch::CancellationRegistry;
use core_documents::{CoreDocumentStore, DocumentContentChange, InitialDocumentSnapshot};
use core_ipc::{
    ClientFrame, ServerFrame, WireCompletionRequest, WireDocumentChange, WireInitialDocument,
    WireTextChange,
};
use core_llama::GenerationClient;
use core_models::{FimModelModule, FimModuleKind, FimRenderInput, GenerationMode};
use core_types::CompletionMode;
use tokio::sync::mpsc::UnboundedSender;

use crate::completion::{spawn_fim_completion, FimCompletion};

/// What the connection loop should do after one frame.
pub enum HandleOutcome {
    /// Keep serving the connection.
    Continue,
    /// Stop serving and shut the core down.
    Shutdown,
}

/// Applies client frames to the shadow store and routes FIM completions.
pub struct CoreFrameHandler {
    store: CoreDocumentStore,
    cancellation: CancellationRegistry,
    generation: GenerationClient,
}

impl CoreFrameHandler {
    /// Creates a handler that routes FIM generation through `generation`.
    #[must_use]
    pub fn new(generation: GenerationClient) -> Self {
        Self {
            store: CoreDocumentStore::new(),
            cancellation: CancellationRegistry::new(),
            generation,
        }
    }

    /// Handles one client frame, emitting any server frames through `out`.
    pub fn handle(
        &mut self,
        frame: ClientFrame,
        out: &UnboundedSender<ServerFrame>,
    ) -> HandleOutcome {
        match frame {
            ClientFrame::InitialDocumentSnapshot(doc) | ClientFrame::OpenBufferSnapshot(doc) => {
                self.apply_snapshot(doc);
                HandleOutcome::Continue
            }
            ClientFrame::DocumentChange(change) => {
                self.apply_change(change);
                HandleOutcome::Continue
            }
            ClientFrame::CompletionRequest(request) => {
                self.start_completion(&request, out);
                HandleOutcome::Continue
            }
            ClientFrame::Cancel(cancel) => {
                self.cancellation.cancel(cancel.request_id);
                HandleOutcome::Continue
            }
            ClientFrame::ConfigUpdate(_) => HandleOutcome::Continue,
            ClientFrame::Shutdown(_) => HandleOutcome::Shutdown,
        }
    }

    fn apply_snapshot(&mut self, doc: WireInitialDocument) {
        self.store.upsert_initial_snapshot(to_initial_snapshot(doc));
    }

    fn apply_change(&mut self, change: WireDocumentChange) {
        let WireDocumentChange {
            uri,
            from_version,
            to_version,
            changes,
        } = change;
        let changes = to_content_changes(changes);

        if let Err(err) = self
            .store
            .apply_changes(&uri, from_version, to_version, &changes)
        {
            tracing::warn!(error = %err, uri = %uri, "failed to apply document change");
        }
    }

    fn start_completion(
        &mut self,
        request: &WireCompletionRequest,
        out: &UnboundedSender<ServerFrame>,
    ) {
        if request.mode != CompletionMode::Fim {
            send_error(out, request.request_id, "pilot routes FIM only");
            return;
        }

        let Some(module) = FimModuleKind::by_model_id(&request.model_id) else {
            send_error(out, request.request_id, "unsupported FIM model");
            return;
        };

        let prompt = match self.build_prompt(module, request) {
            Ok(prompt) => prompt,
            Err(message) => {
                send_error(out, request.request_id, &message);
                return;
            }
        };

        let cancel = self.cancellation.start(request.request_id);
        spawn_fim_completion(FimCompletion {
            client: self.generation.clone(),
            prompt,
            max_tokens: module.max_tokens(GenerationMode::Line),
            stop: module.stop_tokens(),
            cancel,
            out: out.clone(),
            request_id: request.request_id,
        });
    }

    fn build_prompt(
        &self,
        module: FimModuleKind,
        request: &WireCompletionRequest,
    ) -> Result<String, String> {
        let (prefix, suffix) = self
            .store
            .prefix_suffix_at(&request.uri, request.version, request.cursor)
            .map_err(|err| err.to_string())?;

        let input = FimRenderInput {
            language_id: "",
            file_path: &request.uri,
            prefix,
            suffix,
            neighbors: &[],
            generation_mode: GenerationMode::Line,
        };
        Ok(module.render_prompt(&input))
    }
}

fn send_error(out: &UnboundedSender<ServerFrame>, request_id: u64, message: &str) {
    let _ = out.send(ServerFrame::Error {
        request_id,
        message: message.to_owned(),
    });
}

fn to_initial_snapshot(doc: WireInitialDocument) -> InitialDocumentSnapshot {
    InitialDocumentSnapshot {
        uri: doc.uri,
        version: doc.version,
        language_id: doc.language_id,
        file_path: doc.file_path,
        file_mode: doc.file_mode,
        text: doc.text,
    }
}

fn to_content_changes(changes: Vec<WireTextChange>) -> Vec<DocumentContentChange> {
    changes
        .into_iter()
        .map(|change| DocumentContentChange {
            range: change.range,
            range_length: change.range_length,
            inserted_text: change.inserted_text,
        })
        .collect()
}
