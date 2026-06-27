// Pure decoders for the length-prefixed FlatBuffers server frames the core
// sends back. Kept free of socket/Theia deps so the framing stays easy to unit
// test in isolation from the live transport.

import { decodeServerFramePayload } from './core-flatbuffers';

/** Complete frames extracted from a buffer plus the unconsumed remainder. */
export interface DecodedFrames {
    frames: Uint8Array[];
    rest: Buffer;
}

/** Extracts every complete length-prefixed frame, leaving partial bytes behind. */
export function decodeFrames(buffer: Buffer): DecodedFrames {
    const frames: Uint8Array[] = [];
    let offset = 0;

    while (buffer.length - offset >= 4) {
        const length = buffer.readUInt32LE(offset);
        if (buffer.length - offset - 4 < length) {
            break;
        }
        frames.push(buffer.subarray(offset + 4, offset + 4 + length));
        offset += 4 + length;
    }

    return { frames, rest: offset === 0 ? buffer : buffer.subarray(offset) };
}

/** Server frame kinds the client understands. */
export type ServerFrameKind = 'Token' | 'Done' | 'Error' | 'Progress' | 'Edit';

/** Normalized view of a server frame keyed by request id. */
export interface InterpretedFrame {
    kind: ServerFrameKind;
    requestId: number;
    text?: string;
    message?: string;
    newText?: string;
    range?: {
        start_line: number;
        start_col: number;
        end_line: number;
        end_col: number;
    };
    jump?: { line: number; column: number; offset: number };
}

/** Interprets one FlatBuffers server frame, or returns undefined if unknown. */
export function interpretServerFrame(frame: unknown): InterpretedFrame | undefined {
    if (!(frame instanceof Uint8Array)) {
        return undefined;
    }
    try {
        const decoded = decodeServerFramePayload(frame);
        if (!decoded) {
            return undefined;
        }
        return interpretDecodedFrame(decoded);
    } catch {
        return undefined;
    }
}

function interpretDecodedFrame(frame: InterpretedFrame): InterpretedFrame | undefined {
    switch (frame.kind) {
        case 'Token':
            return { kind: frame.kind, requestId: frame.requestId, text: frame.text ?? '' };
        case 'Done':
            return { kind: frame.kind, requestId: frame.requestId };
        case 'Error':
            return { kind: frame.kind, requestId: frame.requestId, message: frame.message ?? '' };
        case 'Progress':
            return { kind: frame.kind, requestId: frame.requestId, text: frame.text ?? '' };
        case 'Edit':
            return {
                kind: frame.kind,
                requestId: frame.requestId,
                newText: frame.newText ?? '',
                range: frame.range,
                jump: frame.jump,
            };
        default:
            return undefined;
    }
}
