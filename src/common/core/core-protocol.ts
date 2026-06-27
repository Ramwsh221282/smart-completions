// RPC contract for the experimental Rust core. Pure data + symbols only, so the
// file is safe to import from both frontend and backend without pulling Theia
// runtime dependencies.

/** Theia RPC path for the Rust core backend service. */
export const CORE_SERVICE_PATH = '/services/smart-completions/core';

/** Whether a document is treated as code or prose. */
export type CoreFileMode = 'code' | 'prose';

/** Which completion pipeline a request targets. */
export type CoreMode = 'fim' | 'nes';

/** Whether a document is file-backed or an untitled buffer. */
export type CoreDocumentKind = 'file' | 'untitled';

/** Monaco-shaped content change (1-based line/column). */
export interface CoreTextChange {
    range: {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
    };
    rangeLength: number;
    text: string;
}

/** Full document snapshot sent once when a document opens. */
export interface CoreInitialDocumentSnapshot {
    uri: string;
    version: number;
    languageId: string;
    filePath?: string;
    fileMode: CoreFileMode;
    kind: CoreDocumentKind;
    text: string;
}

/** Incremental change batch keyed by document version. */
export interface CoreDocumentChange {
    uri: string;
    fromVersion: number;
    toVersion: number;
    changes: CoreTextChange[];
}

/** Cursor position (1-based line/column plus absolute offset). */
export interface CoreCursor {
    lineNumber: number;
    column: number;
    offset: number;
}

/** A completion request routed to the core. */
export interface CoreCompletionRequest {
    requestId: number;
    mode: CoreMode;
    modelId: string;
    uri: string;
    version: number;
    fileMode: CoreFileMode;
    cursor: CoreCursor;
    configVersion: number;
}

/** Acknowledgement for a routed completion request. */
export interface CoreRequestAccepted {
    accepted: boolean;
    reason?: string;
}

/** Current core process status for diagnostics and gating. */
export interface CoreStatus {
    enabled: boolean;
    running: boolean;
    binaryPath?: string;
    socketPath?: string;
    lastError?: string;
}

/** Backend service that owns the Rust core process and forwards frames. */
export const CoreBackendService = Symbol('CoreBackendService');

/** Backend service contract exposed to the frontend over RPC. */
export interface CoreBackendService {
    syncInitialDocument(snapshot: CoreInitialDocumentSnapshot): Promise<void>;
    applyDocumentChange(change: CoreDocumentChange): Promise<void>;
    requestCompletion(request: CoreCompletionRequest): Promise<CoreRequestAccepted>;
    cancel(requestId: number): Promise<void>;
    getStatus(): Promise<CoreStatus>;
}
