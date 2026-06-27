import { Builder, ByteBuffer } from 'flatbuffers';

export type WireMode = 'Fim' | 'Nes';
export type WireFileMode = 'Code' | 'Prose';
export type WireDocumentKind = 'File' | 'Untitled';

export interface WireRange {
    start_line: number;
    start_col: number;
    end_line: number;
    end_col: number;
}

export interface WireTextChange {
    range: WireRange;
    range_length: number;
    inserted_text: string;
}

export interface WireInitialDocument {
    uri: string;
    version: number;
    language_id: string;
    file_path: string | null;
    file_mode: WireFileMode;
    kind: WireDocumentKind;
    text: string;
}

export interface WireDocumentChange {
    uri: string;
    from_version: number;
    to_version: number;
    changes: WireTextChange[];
}

export interface WirePosition {
    line: number;
    column: number;
    offset: number;
}

export interface WireDiagnostic {
    range: WireRange;
    severity: number;
    message: string;
    code?: string;
}

export interface WireOutlineItem {
    name: string;
    kind: string;
    range: WireRange;
    selection_range: WireRange;
}

export interface WireRelatedFileHint {
    path: string;
    range?: WireRange;
    source: string;
    score_hint?: number;
}

export interface WireSignals {
    symbol_at_cursor?: string;
    renamed_symbols: string[];
    imported_symbols: string[];
    declared_types: string[];
    test_names: string[];
    diagnostic_symbols: string[];
    fuzzy_symbols: string[];
    retrieval_signal_hints: string[];
}

export interface WireCompletionRequest {
    request_id: number;
    mode: WireMode;
    model_id: string;
    uri: string;
    version: number;
    language_id: string;
    file_mode: WireFileMode;
    cursor: WirePosition;
    editable_region?: WireRange;
    recent_edit_uris: string[];
    diagnostics: WireDiagnostic[];
    outline: WireOutlineItem[];
    related_file_hints: WireRelatedFileHint[];
    signals?: WireSignals;
    config_version: number;
    config_json?: string;
}

export interface WireConfigUpdate {
    config_version: number;
    config_json: string;
}

export type ClientFrame =
    | { kind: 'InitialDocumentSnapshot'; data: WireInitialDocument }
    | { kind: 'OpenBufferSnapshot'; data: WireInitialDocument }
    | { kind: 'DocumentChange'; data: WireDocumentChange }
    | { kind: 'CompletionRequest'; data: WireCompletionRequest }
    | { kind: 'Cancel'; data: { request_id: number } }
    | { kind: 'ConfigUpdate'; data: WireConfigUpdate }
    | { kind: 'Shutdown'; data: { reason: string } };

export type ServerFramePayload =
    | { kind: 'Token'; requestId: number; text: string }
    | { kind: 'Done'; requestId: number }
    | { kind: 'Error'; requestId: number; message: string }
    | { kind: 'Edit'; requestId: number; newText: string; range?: WireRange; jump?: WirePosition };

export interface DecodedServerFrame {
    kind: 'Token' | 'Done' | 'Error' | 'Edit';
    requestId: number;
    text?: string;
    message?: string;
}

const CLIENT_FRAME_KIND = {
    InitialDocumentSnapshot: 0,
    DocumentChange: 1,
    OpenBufferSnapshot: 2,
    CompletionRequest: 3,
    Cancel: 4,
    ConfigUpdate: 5,
    Shutdown: 6,
} as const;

const FRAME_KIND = {
    Token: 0,
    Done: 1,
    Error: 2,
    Edit: 3,
    Progress: 4,
} as const;

const WIRE_MODE = {
    Fim: 0,
    Nes: 1,
} as const;

const WIRE_FILE_MODE = {
    Code: 0,
    Prose: 1,
} as const;

const DOCUMENT_KIND = {
    File: 0,
    Untitled: 1,
} as const;

const DIAGNOSTIC_SEVERITY = {
    error: 0,
    warning: 1,
    info: 2,
    hint: 3,
} as const;

export function diagnosticSeverityToWire(
    severity: 'error' | 'warning' | 'info' | 'hint',
): number {
    return DIAGNOSTIC_SEVERITY[severity];
}

export function diagnosticSeverityFromWire(severity: number): 'error' | 'warning' | 'info' | 'hint' {
    switch (severity) {
        case DIAGNOSTIC_SEVERITY.warning:
            return 'warning';
        case DIAGNOSTIC_SEVERITY.info:
            return 'info';
        case DIAGNOSTIC_SEVERITY.hint:
            return 'hint';
        default:
            return 'error';
    }
}

export function encodeClientFramePayload(frame: ClientFrame): Uint8Array {
    const builder = new Builder(512);
    builder.finish(createClientFrame(builder, frame));
    return builder.asUint8Array();
}

export function decodeClientFramePayload(payload: Uint8Array): ClientFrame {
    const bb = new ByteBuffer(payload);
    return decodeClientFrame(bb, rootTable(bb));
}

export function encodeServerFramePayload(frame: ServerFramePayload): Uint8Array {
    const builder = new Builder(128);
    builder.finish(createServerFrame(builder, frame));
    return builder.asUint8Array();
}

export function decodeServerFramePayload(payload: Uint8Array): DecodedServerFrame | undefined {
    if (payload.byteLength < 4) {
        return undefined;
    }
    const bb = new ByteBuffer(payload);
    const table = rootTable(bb);
    if (!hasField(bb, table, 4)) {
        return undefined;
    }
    return decodeServerFrame(bb, table);
}

function createClientFrame(builder: Builder, frame: ClientFrame): number {
    const initialDocument =
        frame.kind === 'InitialDocumentSnapshot' ? createInitialDocumentSnapshot(builder, frame.data) : 0;
    const documentChange = frame.kind === 'DocumentChange' ? createDocumentChange(builder, frame.data) : 0;
    const openBuffer = frame.kind === 'OpenBufferSnapshot' ? createOpenBufferSnapshot(builder, frame.data) : 0;
    const request = frame.kind === 'CompletionRequest' ? createCompletionRequest(builder, frame.data) : 0;
    const cancel = frame.kind === 'Cancel' ? createCancel(builder, frame.data.request_id) : 0;
    const configUpdate = frame.kind === 'ConfigUpdate' ? createConfigUpdate(builder, frame.data) : 0;
    const shutdown = frame.kind === 'Shutdown' ? createShutdown(builder, frame.data.reason) : 0;

    builder.startObject(8);
    builder.addFieldInt8(0, clientFrameKindValue(frame.kind), CLIENT_FRAME_KIND.InitialDocumentSnapshot);
    builder.addFieldOffset(1, initialDocument, 0);
    builder.addFieldOffset(2, documentChange, 0);
    builder.addFieldOffset(3, openBuffer, 0);
    builder.addFieldOffset(4, request, 0);
    builder.addFieldOffset(5, cancel, 0);
    builder.addFieldOffset(6, configUpdate, 0);
    builder.addFieldOffset(7, shutdown, 0);
    return builder.endObject();
}

function createInitialDocumentSnapshot(builder: Builder, snapshot: WireInitialDocument): number {
    const uri = createStringOffset(builder, snapshot.uri);
    const languageId = createStringOffset(builder, snapshot.language_id);
    const filePath = createStringOffset(builder, snapshot.file_path);
    const text = createStringOffset(builder, snapshot.text);

    builder.startObject(7);
    builder.addFieldOffset(0, uri, 0);
    builder.addFieldInt32(1, snapshot.version, 0);
    builder.addFieldOffset(2, languageId, 0);
    builder.addFieldOffset(3, filePath, 0);
    builder.addFieldInt8(4, wireFileModeValue(snapshot.file_mode), WIRE_FILE_MODE.Code);
    builder.addFieldInt8(5, wireDocumentKindValue(snapshot.kind), DOCUMENT_KIND.File);
    builder.addFieldOffset(6, text, 0);
    return builder.endObject();
}

function createOpenBufferSnapshot(builder: Builder, snapshot: WireInitialDocument): number {
    const uri = createStringOffset(builder, snapshot.uri);
    const languageId = createStringOffset(builder, snapshot.language_id);
    const text = createStringOffset(builder, snapshot.text);

    builder.startObject(5);
    builder.addFieldOffset(0, uri, 0);
    builder.addFieldInt32(1, snapshot.version, 0);
    builder.addFieldOffset(2, languageId, 0);
    builder.addFieldInt8(3, wireFileModeValue(snapshot.file_mode), WIRE_FILE_MODE.Code);
    builder.addFieldOffset(4, text, 0);
    return builder.endObject();
}

function createDocumentChange(builder: Builder, change: WireDocumentChange): number {
    const uri = createStringOffset(builder, change.uri);
    const changes = createOffsetVector(builder, change.changes.map(item => createTextChange(builder, item)));

    builder.startObject(4);
    builder.addFieldOffset(0, uri, 0);
    builder.addFieldInt32(1, change.from_version, 0);
    builder.addFieldInt32(2, change.to_version, 0);
    builder.addFieldOffset(3, changes, 0);
    return builder.endObject();
}

function createTextChange(builder: Builder, change: WireTextChange): number {
    const range = createRange(builder, change.range);
    const insertedText = createStringOffset(builder, change.inserted_text);

    builder.startObject(3);
    builder.addFieldOffset(0, range, 0);
    builder.addFieldInt32(1, change.range_length, 0);
    builder.addFieldOffset(2, insertedText, 0);
    return builder.endObject();
}

function createCompletionRequest(builder: Builder, request: WireCompletionRequest): number {
    const modelId = createStringOffset(builder, request.model_id);
    const uri = createStringOffset(builder, request.uri);
    const languageId = createStringOffset(builder, request.language_id);
    const cursor = createPosition(builder, request.cursor);
    const editableRegion = request.editable_region ? createRange(builder, request.editable_region) : 0;
    const recentEditUris = createStringVector(builder, request.recent_edit_uris);
    const diagnostics = createOffsetVector(builder, request.diagnostics.map(item => createDiagnostic(builder, item)));
    const outline = createOffsetVector(builder, request.outline.map(item => createOutlineItem(builder, item)));
    const relatedFileHints = createOffsetVector(
        builder,
        request.related_file_hints.map(item => createRelatedFileHint(builder, item)),
    );
    const signals = createSignals(builder, request.signals);
    const configJson = createStringOffset(builder, request.config_json);

    builder.startObject(16);
    builder.addFieldInt64(0, bigintFromNumber(request.request_id), BigInt(0));
    builder.addFieldInt8(1, wireModeValue(request.mode), WIRE_MODE.Fim);
    builder.addFieldOffset(2, modelId, 0);
    builder.addFieldOffset(3, uri, 0);
    builder.addFieldInt32(4, request.version, 0);
    builder.addFieldOffset(5, languageId, 0);
    builder.addFieldInt8(6, wireFileModeValue(request.file_mode), WIRE_FILE_MODE.Code);
    builder.addFieldOffset(7, cursor, 0);
    builder.addFieldOffset(8, editableRegion, 0);
    builder.addFieldOffset(9, recentEditUris, 0);
    builder.addFieldOffset(10, diagnostics, 0);
    builder.addFieldOffset(11, outline, 0);
    builder.addFieldOffset(12, relatedFileHints, 0);
    builder.addFieldOffset(13, signals, 0);
    builder.addFieldInt64(14, bigintFromNumber(request.config_version), BigInt(0));
    builder.addFieldOffset(15, configJson, 0);
    return builder.endObject();
}

function createPosition(builder: Builder, position: WirePosition): number {
    builder.startObject(3);
    builder.addFieldInt32(0, position.line, 0);
    builder.addFieldInt32(1, position.column, 0);
    builder.addFieldInt32(2, position.offset, 0);
    return builder.endObject();
}

function createRange(builder: Builder, range: WireRange): number {
    builder.startObject(4);
    builder.addFieldInt32(0, range.start_line, 0);
    builder.addFieldInt32(1, range.start_col, 0);
    builder.addFieldInt32(2, range.end_line, 0);
    builder.addFieldInt32(3, range.end_col, 0);
    return builder.endObject();
}

function createDiagnostic(builder: Builder, diagnostic: WireDiagnostic): number {
    const range = createRange(builder, diagnostic.range);
    const message = createStringOffset(builder, diagnostic.message);
    const code = createStringOffset(builder, diagnostic.code);

    builder.startObject(4);
    builder.addFieldOffset(0, range, 0);
    builder.addFieldInt8(1, diagnostic.severity, DIAGNOSTIC_SEVERITY.error);
    builder.addFieldOffset(2, message, 0);
    builder.addFieldOffset(3, code, 0);
    return builder.endObject();
}

function createOutlineItem(builder: Builder, item: WireOutlineItem): number {
    const name = createStringOffset(builder, item.name);
    const kind = createStringOffset(builder, item.kind);
    const range = createRange(builder, item.range);
    const selectionRange = createRange(builder, item.selection_range);

    builder.startObject(4);
    builder.addFieldOffset(0, name, 0);
    builder.addFieldOffset(1, kind, 0);
    builder.addFieldOffset(2, range, 0);
    builder.addFieldOffset(3, selectionRange, 0);
    return builder.endObject();
}

function createRelatedFileHint(builder: Builder, hint: WireRelatedFileHint): number {
    const path = createStringOffset(builder, hint.path);
    const range = hint.range ? createRange(builder, hint.range) : 0;
    const source = createStringOffset(builder, hint.source);

    builder.startObject(4);
    builder.addFieldOffset(0, path, 0);
    builder.addFieldOffset(1, range, 0);
    builder.addFieldOffset(2, source, 0);
    builder.addFieldFloat32(3, hint.score_hint ?? 0, 0);
    return builder.endObject();
}

function createSignals(builder: Builder, signals: WireSignals | undefined): number {
    if (!signals || signalsIsEmpty(signals)) {
        return 0;
    }
    const symbolAtCursor = createStringOffset(builder, signals.symbol_at_cursor);
    const renamedSymbols = createStringVector(builder, signals.renamed_symbols);
    const importedSymbols = createStringVector(builder, signals.imported_symbols);
    const declaredTypes = createStringVector(builder, signals.declared_types);
    const testNames = createStringVector(builder, signals.test_names);
    const diagnosticSymbols = createStringVector(builder, signals.diagnostic_symbols);
    const fuzzySymbols = createStringVector(builder, signals.fuzzy_symbols);
    const retrievalSignalHints = createStringVector(builder, signals.retrieval_signal_hints);

    builder.startObject(8);
    builder.addFieldOffset(0, symbolAtCursor, 0);
    builder.addFieldOffset(1, renamedSymbols, 0);
    builder.addFieldOffset(2, importedSymbols, 0);
    builder.addFieldOffset(3, declaredTypes, 0);
    builder.addFieldOffset(4, testNames, 0);
    builder.addFieldOffset(5, diagnosticSymbols, 0);
    builder.addFieldOffset(6, fuzzySymbols, 0);
    builder.addFieldOffset(7, retrievalSignalHints, 0);
    return builder.endObject();
}

function createCancel(builder: Builder, requestId: number): number {
    builder.startObject(1);
    builder.addFieldInt64(0, bigintFromNumber(requestId), BigInt(0));
    return builder.endObject();
}

function createConfigUpdate(builder: Builder, update: WireConfigUpdate): number {
    const json = createStringOffset(builder, update.config_json);

    builder.startObject(2);
    builder.addFieldInt64(0, bigintFromNumber(update.config_version), BigInt(0));
    builder.addFieldOffset(1, json, 0);
    return builder.endObject();
}

function createShutdown(builder: Builder, reason: string): number {
    const reasonOffset = createStringOffset(builder, reason);

    builder.startObject(1);
    builder.addFieldOffset(0, reasonOffset, 0);
    return builder.endObject();
}

function createServerFrame(builder: Builder, frame: ServerFramePayload): number {
    const text =
        frame.kind === 'Token'
            ? createStringOffset(builder, frame.text)
            : frame.kind === 'Error'
              ? createStringOffset(builder, frame.message)
              : 0;
    const newText = frame.kind === 'Edit' ? createStringOffset(builder, frame.newText) : 0;

    builder.startObject(10);
    builder.addFieldInt64(0, bigintFromNumber(frame.requestId), BigInt(0));
    builder.addFieldInt8(1, serverFrameKindValue(frame.kind), FRAME_KIND.Token);
    builder.addFieldOffset(2, text, 0);
    if (frame.kind === 'Edit') {
        builder.addFieldInt32(3, frame.range?.start_line ?? 0, 0);
        builder.addFieldInt32(4, frame.range?.start_col ?? 0, 0);
        builder.addFieldInt32(5, frame.range?.end_line ?? 0, 0);
        builder.addFieldInt32(6, frame.range?.end_col ?? 0, 0);
        builder.addFieldOffset(7, newText, 0);
        builder.addFieldInt32(8, frame.jump?.line ?? 0, 0);
        builder.addFieldInt32(9, frame.jump?.column ?? 0, 0);
    }
    return builder.endObject();
}

function decodeClientFrame(bb: ByteBuffer, table: number): ClientFrame {
    switch (readInt8Field(bb, table, 4, CLIENT_FRAME_KIND.InitialDocumentSnapshot)) {
        case CLIENT_FRAME_KIND.InitialDocumentSnapshot:
            return {
                kind: 'InitialDocumentSnapshot',
                data: decodeInitialDocument(bb, requireTable(bb, table, 6, 'initial_document')),
            };
        case CLIENT_FRAME_KIND.DocumentChange:
            return {
                kind: 'DocumentChange',
                data: decodeDocumentChange(bb, requireTable(bb, table, 8, 'document_change')),
            };
        case CLIENT_FRAME_KIND.OpenBufferSnapshot:
            return {
                kind: 'OpenBufferSnapshot',
                data: decodeOpenBufferSnapshot(bb, requireTable(bb, table, 10, 'open_buffer')),
            };
        case CLIENT_FRAME_KIND.CompletionRequest:
            return {
                kind: 'CompletionRequest',
                data: decodeCompletionRequest(bb, requireTable(bb, table, 12, 'request')),
            };
        case CLIENT_FRAME_KIND.Cancel:
            return {
                kind: 'Cancel',
                data: { request_id: readUint64AsNumber(bb, requireTable(bb, table, 14, 'cancel'), 4) },
            };
        case CLIENT_FRAME_KIND.ConfigUpdate:
            return {
                kind: 'ConfigUpdate',
                data: decodeConfigUpdate(bb, requireTable(bb, table, 16, 'config_update')),
            };
        case CLIENT_FRAME_KIND.Shutdown:
            return {
                kind: 'Shutdown',
                data: { reason: requireStringField(bb, requireTable(bb, table, 18, 'shutdown'), 4, 'shutdown.reason') },
            };
        default:
            throw new Error('unknown client frame kind');
    }
}

function decodeInitialDocument(bb: ByteBuffer, table: number): WireInitialDocument {
    return {
        uri: requireStringField(bb, table, 4, 'initial_document.uri'),
        version: readInt32Field(bb, table, 6, 0),
        language_id: requireStringField(bb, table, 8, 'initial_document.language_id'),
        file_path: readStringField(bb, table, 10) ?? null,
        file_mode: decodeWireFileMode(readInt8Field(bb, table, 12, WIRE_FILE_MODE.Code)),
        kind: decodeWireDocumentKind(readInt8Field(bb, table, 14, DOCUMENT_KIND.File)),
        text: requireStringField(bb, table, 16, 'initial_document.text'),
    };
}

function decodeOpenBufferSnapshot(bb: ByteBuffer, table: number): WireInitialDocument {
    return {
        uri: requireStringField(bb, table, 4, 'open_buffer.uri'),
        version: readInt32Field(bb, table, 6, 0),
        language_id: requireStringField(bb, table, 8, 'open_buffer.language_id'),
        file_path: null,
        file_mode: decodeWireFileMode(readInt8Field(bb, table, 10, WIRE_FILE_MODE.Code)),
        kind: 'Untitled',
        text: requireStringField(bb, table, 12, 'open_buffer.text'),
    };
}

function decodeDocumentChange(bb: ByteBuffer, table: number): WireDocumentChange {
    return {
        uri: requireStringField(bb, table, 4, 'document_change.uri'),
        from_version: readInt32Field(bb, table, 6, 0),
        to_version: readInt32Field(bb, table, 8, 0),
        changes: readTableVector(bb, table, 10, decodeTextChange),
    };
}

function decodeTextChange(bb: ByteBuffer, table: number): WireTextChange {
    return {
        range: decodeRange(bb, requireTable(bb, table, 4, 'text_change.range')),
        range_length: readUint32Field(bb, table, 6, 0),
        inserted_text: requireStringField(bb, table, 8, 'text_change.inserted_text'),
    };
}

function decodeCompletionRequest(bb: ByteBuffer, table: number): WireCompletionRequest {
    return {
        request_id: readUint64AsNumber(bb, table, 4),
        mode: decodeWireMode(readInt8Field(bb, table, 6, WIRE_MODE.Fim)),
        model_id: requireStringField(bb, table, 8, 'completion_request.model_id'),
        uri: requireStringField(bb, table, 10, 'completion_request.uri'),
        version: readInt32Field(bb, table, 12, 0),
        language_id: requireStringField(bb, table, 14, 'completion_request.language_id'),
        file_mode: decodeWireFileMode(readInt8Field(bb, table, 16, WIRE_FILE_MODE.Code)),
        cursor: decodePosition(bb, requireTable(bb, table, 18, 'completion_request.cursor')),
        editable_region: readOptionalRange(bb, table, 20),
        recent_edit_uris: readStringVector(bb, table, 22),
        diagnostics: readTableVector(bb, table, 24, decodeDiagnostic),
        outline: readTableVector(bb, table, 26, decodeOutlineItem),
        related_file_hints: readTableVector(bb, table, 28, decodeRelatedFileHint),
        signals: readOptionalTable(bb, table, 30, decodeSignals),
        config_version: readUint64AsNumber(bb, table, 32),
        config_json: readStringField(bb, table, 34),
    };
}

function decodePosition(bb: ByteBuffer, table: number): WirePosition {
    return {
        line: readInt32Field(bb, table, 4, 0),
        column: readInt32Field(bb, table, 6, 0),
        offset: readUint32Field(bb, table, 8, 0),
    };
}

function decodeRange(bb: ByteBuffer, table: number): WireRange {
    return {
        start_line: readInt32Field(bb, table, 4, 0),
        start_col: readInt32Field(bb, table, 6, 0),
        end_line: readInt32Field(bb, table, 8, 0),
        end_col: readInt32Field(bb, table, 10, 0),
    };
}

function decodeDiagnostic(bb: ByteBuffer, table: number): WireDiagnostic {
    return {
        range: decodeRange(bb, requireTable(bb, table, 4, 'diagnostic.range')),
        severity: readInt8Field(bb, table, 6, DIAGNOSTIC_SEVERITY.error),
        message: requireStringField(bb, table, 8, 'diagnostic.message'),
        code: readStringField(bb, table, 10),
    };
}

function decodeOutlineItem(bb: ByteBuffer, table: number): WireOutlineItem {
    const range = decodeRange(bb, requireTable(bb, table, 8, 'outline.range'));
    return {
        name: requireStringField(bb, table, 4, 'outline.name'),
        kind: requireStringField(bb, table, 6, 'outline.kind'),
        range,
        selection_range: readOptionalRange(bb, table, 10) ?? range,
    };
}

function decodeRelatedFileHint(bb: ByteBuffer, table: number): WireRelatedFileHint {
    return {
        path: requireStringField(bb, table, 4, 'related_file_hint.path'),
        range: readOptionalRange(bb, table, 6),
        source: requireStringField(bb, table, 8, 'related_file_hint.source'),
        score_hint: hasField(bb, table, 10) ? readFloat32Field(bb, table, 10, 0) : undefined,
    };
}

function decodeSignals(bb: ByteBuffer, table: number): WireSignals {
    return {
        symbol_at_cursor: readStringField(bb, table, 4),
        renamed_symbols: readStringVector(bb, table, 6),
        imported_symbols: readStringVector(bb, table, 8),
        declared_types: readStringVector(bb, table, 10),
        test_names: readStringVector(bb, table, 12),
        diagnostic_symbols: readStringVector(bb, table, 14),
        fuzzy_symbols: readStringVector(bb, table, 16),
        retrieval_signal_hints: readStringVector(bb, table, 18),
    };
}

function decodeConfigUpdate(bb: ByteBuffer, table: number): WireConfigUpdate {
    return {
        config_version: readUint64AsNumber(bb, table, 4),
        config_json: requireStringField(bb, table, 6, 'config_update.config_json'),
    };
}

function decodeServerFrame(bb: ByteBuffer, table: number): DecodedServerFrame | undefined {
    const requestId = readUint64AsNumber(bb, table, 4);
    switch (readInt8Field(bb, table, 6, FRAME_KIND.Token)) {
        case FRAME_KIND.Token:
            return { kind: 'Token', requestId, text: readStringField(bb, table, 8) ?? '' };
        case FRAME_KIND.Done:
            return { kind: 'Done', requestId };
        case FRAME_KIND.Error:
            return { kind: 'Error', requestId, message: readStringField(bb, table, 8) ?? '' };
        case FRAME_KIND.Edit:
            return { kind: 'Edit', requestId };
        default:
            return undefined;
    }
}

function createStringOffset(builder: Builder, value: string | null | undefined): number {
    return value == null ? 0 : builder.createString(value);
}

function createStringVector(builder: Builder, values: readonly string[]): number {
    if (values.length === 0) {
        return 0;
    }
    const offsets = new Array<number>(values.length);
    for (let i = 0; i < values.length; i += 1) {
        offsets[i] = builder.createString(values[i]);
    }
    return createOffsetVector(builder, offsets);
}

function createOffsetVector(builder: Builder, offsets: readonly number[]): number {
    if (offsets.length === 0) {
        return 0;
    }
    builder.startVector(4, offsets.length, 4);
    for (let i = offsets.length - 1; i >= 0; i -= 1) {
        builder.addOffset(offsets[i]);
    }
    return builder.endVector();
}

function rootTable(bb: ByteBuffer): number {
    return bb.readInt32(bb.position()) + bb.position();
}

function requireTable(bb: ByteBuffer, table: number, vtableOffset: number, field: string): number {
    const nested = readTableField(bb, table, vtableOffset);
    if (nested === undefined) {
        throw new Error(`missing table ${field}`);
    }
    return nested;
}

function readOptionalTable<T>(
    bb: ByteBuffer,
    table: number,
    vtableOffset: number,
    decode: (bb: ByteBuffer, table: number) => T,
): T | undefined {
    const nested = readTableField(bb, table, vtableOffset);
    return nested === undefined ? undefined : decode(bb, nested);
}

function readTableField(bb: ByteBuffer, table: number, vtableOffset: number): number | undefined {
    const offset = bb.__offset(table, vtableOffset);
    return offset ? bb.__indirect(table + offset) : undefined;
}

function hasField(bb: ByteBuffer, table: number, vtableOffset: number): boolean {
    return bb.__offset(table, vtableOffset) !== 0;
}

function readOptionalRange(bb: ByteBuffer, table: number, vtableOffset: number): WireRange | undefined {
    return readOptionalTable(bb, table, vtableOffset, decodeRange);
}

function requireStringField(bb: ByteBuffer, table: number, vtableOffset: number, field: string): string {
    const value = readStringField(bb, table, vtableOffset);
    if (value === undefined) {
        throw new Error(`missing string ${field}`);
    }
    return value;
}

function readStringField(bb: ByteBuffer, table: number, vtableOffset: number): string | undefined {
    const offset = bb.__offset(table, vtableOffset);
    return offset ? (bb.__string(table + offset) as string) : undefined;
}

function readStringVector(bb: ByteBuffer, table: number, vtableOffset: number): string[] {
    const offset = bb.__offset(table, vtableOffset);
    if (!offset) {
        return [];
    }
    const vector = bb.__vector(table + offset);
    const length = bb.__vector_len(table + offset);
    const values = new Array<string>(length);
    for (let i = 0; i < length; i += 1) {
        values[i] = bb.__string(vector + i * 4) as string;
    }
    return values;
}

function readTableVector<T>(
    bb: ByteBuffer,
    table: number,
    vtableOffset: number,
    decode: (bb: ByteBuffer, table: number) => T,
): T[] {
    const offset = bb.__offset(table, vtableOffset);
    if (!offset) {
        return [];
    }
    const vectorOffset = bb.__vector(table + offset);
    const length = bb.__vector_len(table + offset);
    const items = new Array<T>(length);
    for (let i = 0; i < length; i += 1) {
        items[i] = decode(bb, bb.__indirect(vectorOffset + i * 4));
    }
    return items;
}

function readInt8Field(bb: ByteBuffer, table: number, vtableOffset: number, defaultValue: number): number {
    const offset = bb.__offset(table, vtableOffset);
    return offset ? bb.readInt8(table + offset) : defaultValue;
}

function readInt32Field(bb: ByteBuffer, table: number, vtableOffset: number, defaultValue: number): number {
    const offset = bb.__offset(table, vtableOffset);
    return offset ? bb.readInt32(table + offset) : defaultValue;
}

function readUint32Field(bb: ByteBuffer, table: number, vtableOffset: number, defaultValue: number): number {
    const offset = bb.__offset(table, vtableOffset);
    return offset ? bb.readUint32(table + offset) : defaultValue;
}

function readUint64AsNumber(bb: ByteBuffer, table: number, vtableOffset: number): number {
    const offset = bb.__offset(table, vtableOffset);
    return bigintToNumber(offset ? bb.readUint64(table + offset) : BigInt(0));
}

function readFloat32Field(bb: ByteBuffer, table: number, vtableOffset: number, defaultValue: number): number {
    const offset = bb.__offset(table, vtableOffset);
    return offset ? bb.readFloat32(table + offset) : defaultValue;
}

function clientFrameKindValue(kind: ClientFrame['kind']): number {
    return CLIENT_FRAME_KIND[kind];
}

function wireModeValue(mode: WireMode): number {
    return mode === 'Nes' ? WIRE_MODE.Nes : WIRE_MODE.Fim;
}

function decodeWireMode(mode: number): WireMode {
    return mode === WIRE_MODE.Nes ? 'Nes' : 'Fim';
}

function wireFileModeValue(mode: WireFileMode): number {
    return mode === 'Prose' ? WIRE_FILE_MODE.Prose : WIRE_FILE_MODE.Code;
}

function decodeWireFileMode(mode: number): WireFileMode {
    return mode === WIRE_FILE_MODE.Prose ? 'Prose' : 'Code';
}

function wireDocumentKindValue(kind: WireDocumentKind): number {
    return kind === 'Untitled' ? DOCUMENT_KIND.Untitled : DOCUMENT_KIND.File;
}

function decodeWireDocumentKind(kind: number): WireDocumentKind {
    return kind === DOCUMENT_KIND.Untitled ? 'Untitled' : 'File';
}

function signalsIsEmpty(signals: WireSignals): boolean {
    return !signals.symbol_at_cursor &&
        signals.renamed_symbols.length === 0 &&
        signals.imported_symbols.length === 0 &&
        signals.declared_types.length === 0 &&
        signals.test_names.length === 0 &&
        signals.diagnostic_symbols.length === 0 &&
        signals.fuzzy_symbols.length === 0 &&
        signals.retrieval_signal_hints.length === 0;
}

function serverFrameKindValue(kind: ServerFramePayload['kind']): number {
    switch (kind) {
        case 'Done':
            return FRAME_KIND.Done;
        case 'Error':
            return FRAME_KIND.Error;
        case 'Edit':
            return FRAME_KIND.Edit;
        default:
            return FRAME_KIND.Token;
    }
}

function bigintFromNumber(value: number): bigint {
    return BigInt(assertSafeInteger(value, 'number'));
}

function bigintToNumber(value: bigint): number {
    const asNumber = Number(value);
    return assertSafeInteger(asNumber, 'bigint');
}

function assertSafeInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value)) {
        throw new Error(`${label} exceeds the safe integer range`);
    }
    return value;
}
