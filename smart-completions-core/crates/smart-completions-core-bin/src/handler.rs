//! Frame handler bridging IPC frames to the document store and dispatcher.

use core_dispatch::{DispatchRequest, DispatchResponse, Dispatcher};
use core_documents::{CoreDocumentStore, DocumentContentChange, InitialDocumentSnapshot};
use core_ipc::{
    ClientFrame, FrameHandler, HandlerOutcome, ServerFrame, WireCompletionRequest,
    WireDocumentChange, WireInitialDocument, WireTextChange,
};
use tracing::warn;

/// Applies client frames to the shadow store and routes completion requests.
pub(crate) struct CoreFrameHandler {
    store: CoreDocumentStore,
    dispatcher: Dispatcher,
}

impl CoreFrameHandler {
    /// Creates a handler with an empty store and dispatcher.
    pub(crate) fn new() -> Self {
        Self {
            store: CoreDocumentStore::new(),
            dispatcher: Dispatcher::new(),
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
            warn!(error = %err, uri = %uri, "failed to apply document change");
        }
    }

    fn run_completion(&mut self, request: WireCompletionRequest) -> ServerFrame {
        let dispatch = DispatchRequest {
            request_id: request.request_id,
            mode: request.mode,
            model_id: request.model_id,
            uri: request.uri,
            version: request.version,
        };

        match self.dispatcher.dispatch(&dispatch) {
            DispatchResponse::Started => ServerFrame::Done {
                request_id: dispatch.request_id,
            },
            DispatchResponse::Skipped { reason } => ServerFrame::Error {
                request_id: dispatch.request_id,
                message: reason,
            },
        }
    }
}

impl FrameHandler for CoreFrameHandler {
    fn handle(&mut self, frame: ClientFrame) -> HandlerOutcome {
        match frame {
            ClientFrame::InitialDocumentSnapshot(doc) | ClientFrame::OpenBufferSnapshot(doc) => {
                self.apply_snapshot(doc);
                HandlerOutcome::Continue(Vec::new())
            }
            ClientFrame::DocumentChange(change) => {
                self.apply_change(change);
                HandlerOutcome::Continue(Vec::new())
            }
            ClientFrame::CompletionRequest(request) => {
                HandlerOutcome::Continue(vec![self.run_completion(request)])
            }
            ClientFrame::Cancel(cancel) => {
                self.dispatcher.cancel(cancel.request_id);
                HandlerOutcome::Continue(Vec::new())
            }
            ClientFrame::ConfigUpdate(_) => HandlerOutcome::Continue(Vec::new()),
            ClientFrame::Shutdown(_) => HandlerOutcome::Shutdown,
        }
    }
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
