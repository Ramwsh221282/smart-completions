// Pure decoders for the length-prefixed JSON server frames the core sends back.
// Kept free of socket/Theia deps so the framing and interpretation can be
// unit-tested directly.

/** Complete frames extracted from a buffer plus the unconsumed remainder. */
export interface DecodedFrames {
    frames: unknown[];
    rest: Buffer;
}

/** Extracts every complete length-prefixed frame, leaving partial bytes behind. */
export function decodeFrames(buffer: Buffer): DecodedFrames {
    const frames: unknown[] = [];
    let offset = 0;

    while (buffer.length - offset >= 4) {
        const length = buffer.readUInt32LE(offset);
        if (buffer.length - offset - 4 < length) {
            break;
        }
        const payload = buffer.subarray(offset + 4, offset + 4 + length);
        frames.push(JSON.parse(payload.toString('utf8')));
        offset += 4 + length;
    }

    return { frames, rest: offset === 0 ? buffer : buffer.subarray(offset) };
}

/** Server frame kinds the client understands. */
export type ServerFrameKind = 'Token' | 'Done' | 'Error' | 'Edit';

/** Normalized view of a server frame keyed by request id. */
export interface InterpretedFrame {
    kind: ServerFrameKind;
    requestId: number;
    text?: string;
    message?: string;
}

/** Interprets an adjacently tagged server frame, or returns undefined if unknown. */
export function interpretServerFrame(frame: unknown): InterpretedFrame | undefined {
    if (!isRecord(frame)) {
        return undefined;
    }
    const { kind, data } = frame;
    if (typeof kind !== 'string' || !isRecord(data)) {
        return undefined;
    }
    if (typeof data.request_id !== 'number') {
        return undefined;
    }
    return interpretByKind(kind, data.request_id, data);
}

function interpretByKind(
    kind: string,
    requestId: number,
    data: Record<string, unknown>,
): InterpretedFrame | undefined {
    switch (kind) {
        case 'Token':
            return { kind, requestId, text: asString(data.text) };
        case 'Done':
            return { kind, requestId };
        case 'Error':
            return { kind, requestId, message: asString(data.message) };
        case 'Edit':
            return { kind, requestId };
        default:
            return undefined;
    }
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
