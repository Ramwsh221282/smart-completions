// Length-prefixed JSON transport to the Rust core. The wire shape mirrors the
// core's serde frames (snake_case fields, adjacently tagged { kind, data },
// PascalCase enums). FlatBuffers via planus is the target encoding; this JSON
// framing is the transitional smoke path.
//
// NOTE: Monaco ranges are UTF-16 and 1-based; the core treats columns as
// 0-based. Full UTF-16<->byte reconciliation is pending; for now we shift to
// 0-based, which is exact for ASCII content.

import * as net from 'net';
import {
    CoreCompletionRequest,
    CoreDocumentChange,
    CoreInitialDocumentSnapshot,
    CoreTextChange,
} from '../../common/core/core-protocol';

type WireFileMode = 'Code' | 'Prose';
type WireMode = 'Fim' | 'Nes';

interface WireRange {
    start_line: number;
    start_col: number;
    end_line: number;
    end_col: number;
}

interface WireTextChange {
    range: WireRange;
    range_length: number;
    inserted_text: string;
}

interface WireInitialDocument {
    uri: string;
    version: number;
    language_id: string;
    file_path: string | null;
    file_mode: WireFileMode;
    text: string;
}

interface WireDocumentChange {
    uri: string;
    from_version: number;
    to_version: number;
    changes: WireTextChange[];
}

interface WirePosition {
    line: number;
    column: number;
    offset: number;
}

interface WireCompletionRequest {
    request_id: number;
    mode: WireMode;
    model_id: string;
    uri: string;
    version: number;
    file_mode: WireFileMode;
    cursor: WirePosition;
    config_version: number;
}

/** A frame sent from Node to the core, matching the serde wire enum. */
export type ClientFrame =
    | { kind: 'InitialDocumentSnapshot'; data: WireInitialDocument }
    | { kind: 'OpenBufferSnapshot'; data: WireInitialDocument }
    | { kind: 'DocumentChange'; data: WireDocumentChange }
    | { kind: 'CompletionRequest'; data: WireCompletionRequest }
    | { kind: 'Cancel'; data: { request_id: number } }
    | { kind: 'Shutdown'; data: { reason: string } };

/** Maps the high-level file mode to the wire enum spelling. */
export function fileModeToWire(mode: CoreFileModeInput): WireFileMode {
    return mode === 'prose' ? 'Prose' : 'Code';
}

/** Maps the high-level completion mode to the wire enum spelling. */
export function modeToWire(mode: CoreModeInput): WireMode {
    return mode === 'nes' ? 'Nes' : 'Fim';
}

type CoreFileModeInput = 'code' | 'prose';
type CoreModeInput = 'fim' | 'nes';

/** Converts a document snapshot to its wire representation. */
export function toWireInitialDocument(snapshot: CoreInitialDocumentSnapshot): WireInitialDocument {
    return {
        uri: snapshot.uri,
        version: snapshot.version,
        language_id: snapshot.languageId,
        file_path: snapshot.filePath ?? null,
        file_mode: fileModeToWire(snapshot.fileMode),
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
        file_mode: fileModeToWire(request.fileMode),
        cursor: {
            line: request.cursor.lineNumber - 1,
            column: request.cursor.column - 1,
            offset: request.cursor.offset,
        },
        config_version: request.configVersion,
    };
}

/** Encodes a client frame as a length-prefixed JSON buffer. */
export function encodeFrame(frame: ClientFrame): Buffer {
    const payload = Buffer.from(JSON.stringify(frame), 'utf8');
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(payload.length, 0);
    return Buffer.concat([header, payload]);
}

/** Connects to the core socket and writes length-prefixed JSON frames. */
export class CoreIpcClient {
    private socket: net.Socket | undefined;

    async connect(socketPath: string): Promise<void> {
        this.socket = await openSocket(socketPath);
    }

    isConnected(): boolean {
        return this.socket !== undefined;
    }

    async shutdown(): Promise<void> {
        await this.trySend({ kind: 'Shutdown', data: { reason: 'frontend shutdown' } });
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

    async sendCompletionRequest(request: CoreCompletionRequest): Promise<void> {
        await this.send({ kind: 'CompletionRequest', data: toWireCompletionRequest(request) });
    }

    async cancel(requestId: number): Promise<void> {
        await this.send({ kind: 'Cancel', data: { request_id: requestId } });
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
