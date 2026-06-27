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

/** Cursor position (1-based line/column plus absolute UTF-16 offset). */
export interface CoreCursor {
    lineNumber: number;
    column: number;
    offset: number;
}

/** Lightweight 0-based position DTO for diagnostics, outline and region hints. */
export interface CoreIndexedPosition {
    line: number;
    character: number;
}

/** Lightweight 0-based range DTO for diagnostics, outline and region hints. */
export interface CoreIndexedRange {
    start: CoreIndexedPosition;
    end: CoreIndexedPosition;
}

/** Severity labels mirrored from the editor diagnostics pipeline. */
export type CoreDiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

/** Diagnostic hint sent as raw signal, not as rendered prompt text. */
export interface CoreDiagnostic {
    range: CoreIndexedRange;
    severity: CoreDiagnosticSeverity;
    message: string;
    code?: string;
}

/** Outline item from frontend structure sources. */
export interface CoreOutlineItem {
    name: string;
    kind: string;
    range: CoreIndexedRange;
    selectionRange?: CoreIndexedRange;
}

/** Related-file pointer that lets the core load and rank context itself. */
export interface CoreRelatedFileHint {
    path: string;
    range?: CoreIndexedRange;
    source: string;
    scoreHint?: number;
}

/** Raw retrieval/query signals gathered on the frontend. */
export interface CoreSignals {
    symbolAtCursor?: string;
    renamedSymbols?: string[];
    importedSymbols?: string[];
    declaredTypes?: string[];
    testNames?: string[];
    diagnosticSymbols?: string[];
    fuzzySymbols?: string[];
    retrievalSignalHints?: string[];
}

/** Compact recent edit payload forwarded to the Rust core. */
export interface CoreRecentEdit {
    uri: string;
    unifiedDiff: string;
    timestamp: number;
}

/** One edit suggestion returned by the Rust core. */
export interface CoreCompletionEdit {
    range: CoreIndexedRange;
    newText: string;
    jumpTo?: CoreIndexedPosition;
}

/** Config push matching the dedicated ConfigUpdate frame in the schema. */
export interface CoreConfigUpdate {
    configVersion: number;
    configJson: string;
}

/** A completion request routed to the core. */
export interface CoreCompletionRequest {
    requestId: number;
    mode: CoreMode;
    modelId: string;
    uri: string;
    version: number;
    languageId: string;
    fileMode: CoreFileMode;
    cursor: CoreCursor;
    editableRegion?: CoreIndexedRange;
    recentEditUris?: string[];
    recentEdits?: CoreRecentEdit[];
    originalWindowText?: string;
    diagnostics?: CoreDiagnostic[];
    outline?: CoreOutlineItem[];
    relatedFileHints?: CoreRelatedFileHint[];
    signals?: CoreSignals;
    configVersion: number;
    configJson?: string;
}

/** Result of a routed completion request: either text or one edit. */
export interface CoreCompletionResult {
    accepted: boolean;
    text?: string;
    edit?: CoreCompletionEdit;
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
    syncConfig(update: CoreConfigUpdate): Promise<void>;
    requestCompletion(request: CoreCompletionRequest): Promise<CoreCompletionResult>;
    cancel(requestId: number): Promise<void>;
    getStatus(): Promise<CoreStatus>;
}
