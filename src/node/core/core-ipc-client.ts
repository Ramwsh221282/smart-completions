// Length-prefixed FlatBuffers transport to the Rust core. The schema already
// covers a richer envelope than the active FIM pilot path, so the TS side
// packs the current subset and leaves future-only fields at null/default.
//
// NOTE: Monaco ranges are UTF-16 and 1-based on the TS side. The Rust shadow
// document store resolves the transmitted 0-based UTF-16 columns/offsets to
// UTF-8 byte offsets when it builds prefix/suffix and applies changes.

import * as net from 'node:net';
import {
    CoreCompletionEdit,
    CoreConfigUpdate,
    CoreCompletionRequest,
    CoreDocumentChange,
    CoreInitialDocumentSnapshot,
    CoreTextChange,
} from '../../common/core/core-protocol';
import { decodeFrames, interpretServerFrame, type ServerFrameKind } from './core-frames';
import {
    type ClientFrame,
    diagnosticSeverityToWire,
    type WireCompletionRequest,
    type WireConfigUpdate,
    type WireDiagnostic,
    type WireDocumentChange,
    type WireFileMode,
    type WireInitialDocument,
    type WireMode,
    type WireOutlineItem,
    type WireRecentEdit,
    type WireRelatedFileHint,
    type WireSignals,
    type WireTextChange,
    encodeClientFramePayload,
} from './core-flatbuffers';

const REQUEST_TIMEOUT_MS = 15_000;

type CoreFileModeInput = 'code' | 'prose';
type CoreModeInput = 'fim' | 'nes';

export interface CoreIpcCompletionResult {
    text?: string;
    edit?: CoreCompletionEdit;
}

/** Maps the high-level file mode to the wire enum spelling. */
export function fileModeToWire(mode: CoreFileModeInput): WireFileMode {
    return mode === 'prose' ? 'Prose' : 'Code';
}

/** Maps the high-level completion mode to the wire enum spelling. */
export function modeToWire(mode: CoreModeInput): WireMode {
    return mode === 'nes' ? 'Nes' : 'Fim';
}

/** Converts a document snapshot to its wire representation. */
export function toWireInitialDocument(snapshot: CoreInitialDocumentSnapshot): WireInitialDocument {
    return {
        uri: snapshot.uri,
        version: snapshot.version,
        language_id: snapshot.languageId,
        file_path: snapshot.filePath ?? null,
        file_mode: fileModeToWire(snapshot.fileMode),
        kind: snapshot.kind === 'untitled' ? 'Untitled' : 'File',
        text: snapshot.text,
    };
}

/** Converts a change batch to its wire representation. */
export function toWireDocumentChange(change: CoreDocumentChange): WireDocumentChange {
    return {
        uri: change.uri,
        from_version: change.fromVersion,
        to_version: change.toVersion,
        changes: change.changes.map(toWireTextChange),
    };
}

/** Converts a completion request to its wire representation. */
export function toWireCompletionRequest(request: CoreCompletionRequest): WireCompletionRequest {
    return {
        request_id: request.requestId,
        mode: modeToWire(request.mode),
        model_id: request.modelId,
        uri: request.uri,
        version: request.version,
        language_id: request.languageId,
        file_mode: fileModeToWire(request.fileMode),
        cursor: {
            line: request.cursor.lineNumber - 1,
            column: request.cursor.column - 1,
            offset: request.cursor.offset,
        },
        editable_region: request.editableRegion ? toWireIndexedRange(request.editableRegion) : undefined,
        recent_edit_uris: request.recentEditUris ?? [],
        recent_edits: toWireRecentEdits(request.recentEdits),
        original_window_text: request.originalWindowText,
        diagnostics: toWireDiagnostics(request.diagnostics),
        outline: toWireOutline(request.outline),
        related_file_hints: toWireRelatedFileHints(request.relatedFileHints),
        signals: toWireSignals(request.signals),
        config_version: request.configVersion,
        config_json: request.configJson,
    };
}

/** Converts a config push to its wire representation. */
export function toWireConfigUpdate(update: CoreConfigUpdate): WireConfigUpdate {
    return {
        config_version: update.configVersion,
        config_json: update.configJson,
    };
}

/** Encodes a client frame as a length-prefixed FlatBuffers buffer. */
export function encodeFrame(frame: ClientFrame): Buffer {
    const payload = Buffer.from(encodeClientFramePayload(frame));
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(payload.length, 0);
    return Buffer.concat([header, payload]);
}

interface PendingCompletion {
    tokens: string[];
    edit: CoreCompletionEdit | undefined;
    resolve: (result: CoreIpcCompletionResult) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** Connects to the core socket, writes client frames, and assembles responses. */
export class CoreIpcClient {
    private socket: net.Socket | undefined;
    private buffer: Buffer = Buffer.alloc(0);
    private readonly pending = new Map<number, PendingCompletion>();

    async connect(socketPath: string): Promise<void> {
        const socket = await openSocket(socketPath);
        this.attachReader(socket);
        this.socket = socket;
    }

    isConnected(): boolean {
        return this.socket !== undefined;
    }

    async shutdown(): Promise<void> {
        await this.trySend({ kind: 'Shutdown', data: { reason: 'frontend shutdown' } });
        this.failAll(new Error('core ipc shut down'));
        this.socket?.end();
        this.socket = undefined;
    }

    async sendInitialDocument(snapshot: CoreInitialDocumentSnapshot): Promise<void> {
        const kind = snapshot.kind === 'untitled' ? 'OpenBufferSnapshot' : 'InitialDocumentSnapshot';
        await this.send({ kind, data: toWireInitialDocument(snapshot) });
    }

    async sendDocumentChange(change: CoreDocumentChange): Promise<void> {
        await this.send({ kind: 'DocumentChange', data: toWireDocumentChange(change) });
    }

    async sendConfigUpdate(update: CoreConfigUpdate): Promise<void> {
        await this.send({ kind: 'ConfigUpdate', data: toWireConfigUpdate(update) });
    }

    /** Sends a completion request and resolves with text or one edit. */
    requestCompletion(request: CoreCompletionRequest): Promise<CoreIpcCompletionResult> {
        return new Promise<CoreIpcCompletionResult>((resolve, reject) => {
            this.registerPending(request.requestId, resolve, reject);
            this.send({ kind: 'CompletionRequest', data: toWireCompletionRequest(request) }).catch(
                error => this.settleReject(request.requestId, toError(error)),
            );
        });
    }

    async cancel(requestId: number): Promise<void> {
        await this.trySend({ kind: 'Cancel', data: { request_id: requestId } });
        // Never surface a half-streamed completion: settle empty so the UI shows
        // nothing rather than a stale partial token sequence.
        this.settleEmpty(requestId);
    }

    private registerPending(
        requestId: number,
        resolve: (result: CoreIpcCompletionResult) => void,
        reject: (error: Error) => void,
    ): void {
        // A timeout fails open to an empty result for the same reason as cancel:
        // a partial completion is worse than no suggestion.
        const timer = setTimeout(() => this.settleEmpty(requestId), REQUEST_TIMEOUT_MS);
        this.pending.set(requestId, { tokens: [], edit: undefined, resolve, reject, timer });
    }

    private attachReader(socket: net.Socket): void {
        socket.on('data', (chunk: Buffer | string) => {
            this.onData(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
        });
        socket.on('close', () => this.failAll(new Error('core socket closed')));
        socket.on('error', error => this.failAll(toError(error)));
    }

    private onData(chunk: Buffer): void {
        const { frames, rest } = decodeFrames(Buffer.concat([this.buffer, chunk]));
        this.buffer = rest;
        for (const frame of frames) {
            this.dispatch(frame);
        }
    }

    private dispatch(frame: unknown): void {
        const interpreted = interpretServerFrame(frame);
        if (!interpreted) {
            return;
        }
        const pending = this.pending.get(interpreted.requestId);
        if (!pending) {
            return;
        }
        this.applyFrame(pending, interpreted.kind, interpreted);
    }

    private applyFrame(
        pending: PendingCompletion,
        kind: ServerFrameKind,
        interpreted: {
            requestId: number;
            text?: string;
            message?: string;
            newText?: string;
            range?: { start_line: number; start_col: number; end_line: number; end_col: number };
            jump?: { line: number; column: number; offset: number };
        },
    ): void {
        if (kind === 'Token') {
            pending.tokens.push(interpreted.text ?? '');
        } else if (kind === 'Edit') {
            pending.edit = toCoreEdit(interpreted);
        } else if (kind === 'Done') {
            this.settleResolve(interpreted.requestId, pending);
        } else if (kind === 'Error') {
            this.settleReject(interpreted.requestId, new Error(interpreted.message ?? 'core error'));
        }
        // 'Progress' is informational: it must not settle the request, so the
        // stream keeps flowing until Done/Error/Edit.
    }

    private settleResolve(requestId: number, pending: PendingCompletion): void {
        const result = pending.edit ? { edit: pending.edit } : { text: pending.tokens.join('') };
        const active = this.takePending(requestId);
        active?.resolve(result);
    }

    // Resolves with no text and no edit; used for cancel/timeout so accumulated
    // partial tokens are discarded instead of being shown.
    private settleEmpty(requestId: number): void {
        const pending = this.takePending(requestId);
        pending?.resolve({ text: '' });
    }

    private settleReject(requestId: number, error: Error): void {
        const pending = this.takePending(requestId);
        pending?.reject(error);
    }

    private takePending(requestId: number): PendingCompletion | undefined {
        const pending = this.pending.get(requestId);
        if (!pending) {
            return undefined;
        }
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        return pending;
    }

    private failAll(error: Error): void {
        for (const requestId of [...this.pending.keys()]) {
            this.settleReject(requestId, error);
        }
    }

    private async send(frame: ClientFrame): Promise<void> {
        const socket = this.socket;
        if (!socket) {
            throw new Error('core ipc socket is not connected');
        }
        await writeAll(socket, encodeFrame(frame));
    }

    private async trySend(frame: ClientFrame): Promise<void> {
        await this.send(frame).catch(() => undefined);
    }
}

function toWireTextChange(change: CoreTextChange): WireTextChange {
    return {
        range: {
            start_line: change.range.startLineNumber - 1,
            start_col: change.range.startColumn - 1,
            end_line: change.range.endLineNumber - 1,
            end_col: change.range.endColumn - 1,
        },
        range_length: change.rangeLength,
        inserted_text: change.text,
    };
}

function toWireIndexedRange(range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
}): WireDiagnostic['range'] {
    return {
        start_line: range.start.line,
        start_col: range.start.character,
        end_line: range.end.line,
        end_col: range.end.character,
    };
}

function toWireDiagnostics(
    diagnostics: CoreCompletionRequest['diagnostics'],
): WireDiagnostic[] {
    if (!diagnostics?.length) {
        return [];
    }
    return diagnostics.map(diagnostic => ({
        range: toWireIndexedRange(diagnostic.range),
        severity: diagnosticSeverityToWire(diagnostic.severity),
        message: diagnostic.message,
        code: diagnostic.code,
    }));
}

function toWireOutline(outline: CoreCompletionRequest['outline']): WireOutlineItem[] {
    if (!outline?.length) {
        return [];
    }
    return outline.map(item => ({
        name: item.name,
        kind: item.kind,
        range: toWireIndexedRange(item.range),
        selection_range: toWireIndexedRange(item.selectionRange ?? item.range),
    }));
}

function toWireRelatedFileHints(
    hints: CoreCompletionRequest['relatedFileHints'],
): WireRelatedFileHint[] {
    if (!hints?.length) {
        return [];
    }
    return hints.map(hint => ({
        path: hint.path,
        range: hint.range ? toWireIndexedRange(hint.range) : undefined,
        source: hint.source,
        score_hint: hint.scoreHint,
    }));
}

function toWireRecentEdits(edits: CoreCompletionRequest['recentEdits']): WireRecentEdit[] {
    if (!edits?.length) {
        return [];
    }
    return edits.map(edit => ({
        uri: edit.uri,
        unified_diff: edit.unifiedDiff,
        timestamp: edit.timestamp,
    }));
}

function toWireSignals(signals: CoreCompletionRequest['signals']): WireSignals | undefined {
    if (!signals) {
        return undefined;
    }
    return {
        symbol_at_cursor: signals.symbolAtCursor,
        renamed_symbols: signals.renamedSymbols ?? [],
        imported_symbols: signals.importedSymbols ?? [],
        declared_types: signals.declaredTypes ?? [],
        test_names: signals.testNames ?? [],
        diagnostic_symbols: signals.diagnosticSymbols ?? [],
        fuzzy_symbols: signals.fuzzySymbols ?? [],
        retrieval_signal_hints: signals.retrievalSignalHints ?? [],
    };
}

function toCoreEdit(interpreted: {
    newText?: string;
    range?: { start_line: number; start_col: number; end_line: number; end_col: number };
    jump?: { line: number; column: number; offset: number };
}): CoreCompletionEdit | undefined {
    if (!interpreted.range || interpreted.newText === undefined) {
        return undefined;
    }
    return {
        range: {
            start: { line: interpreted.range.start_line, character: interpreted.range.start_col },
            end: { line: interpreted.range.end_line, character: interpreted.range.end_col },
        },
        newText: interpreted.newText,
        jumpTo: interpreted.jump
            ? { line: interpreted.jump.line, character: interpreted.jump.column }
            : undefined,
    };
}

function openSocket(socketPath: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
    });
}

function writeAll(socket: net.Socket, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
        socket.write(data, error => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}
