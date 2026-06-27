import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeServerFramePayload } from '../src/node/core/core-flatbuffers';
import { decodeFrames, interpretServerFrame } from '../src/node/core/core-frames';

function frame(value: Parameters<typeof encodeServerFramePayload>[0]): Buffer {
    const payload = Buffer.from(encodeServerFramePayload(value));
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(payload.length, 0);
    return Buffer.concat([header, payload]);
}

test('decodeFrames extracts complete frames and keeps a partial remainder', () => {
    const first = frame({ kind: 'Token', requestId: 1, text: 'he' });
    const second = frame({ kind: 'Done', requestId: 1 });
    const combined = Buffer.concat([first, second]);

    const partial = decodeFrames(combined.subarray(0, first.length + 3));
    assert.equal(partial.frames.length, 1);

    const completed = decodeFrames(Buffer.concat([partial.rest, combined.subarray(first.length + 3)]));
    assert.equal(completed.frames.length, 1);
    assert.equal(completed.rest.length, 0);
});

test('interpretServerFrame normalizes token, done and error frames', () => {
    assert.deepEqual(interpretServerFrame(encodeServerFramePayload({ kind: 'Token', requestId: 7, text: 'x' })), {
        kind: 'Token',
        requestId: 7,
        text: 'x',
    });
    assert.deepEqual(interpretServerFrame(encodeServerFramePayload({ kind: 'Done', requestId: 7 })), {
        kind: 'Done',
        requestId: 7,
    });
    assert.deepEqual(interpretServerFrame(encodeServerFramePayload({ kind: 'Error', requestId: 7, message: 'boom' })), {
        kind: 'Error',
        requestId: 7,
        message: 'boom',
    });
});

test('interpretServerFrame rejects malformed frames', () => {
    assert.equal(interpretServerFrame(Buffer.alloc(0)), undefined);
    assert.equal(interpretServerFrame(Buffer.from([1, 2, 3])), undefined);
    assert.equal(interpretServerFrame(null), undefined);
    assert.equal(interpretServerFrame({ kind: 'Weird' }), undefined);
});
