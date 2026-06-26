import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeAfterInsertedText } from '../src/common/sweep/diagnostics-delta';

/** Проверяет inverse range для однострочной NES-правки. */
test('rangeAfterInsertedText handles single-line inserted text', () => {
    assert.deepEqual(rangeAfterInsertedText({ line: 2, character: 4 }, 'abc'), {
        start: { line: 2, character: 4 },
        end: { line: 2, character: 7 },
    });
});

/** Проверяет inverse range для multiline и CRLF-текста без зависимости от Monaco runtime. */
test('rangeAfterInsertedText handles LF and CRLF inserted text', () => {
    assert.deepEqual(rangeAfterInsertedText({ line: 1, character: 2 }, 'ab\ncd'), {
        start: { line: 1, character: 2 },
        end: { line: 2, character: 2 },
    });
    assert.deepEqual(rangeAfterInsertedText({ line: 1, character: 2 }, 'ab\r\ncd'), {
        start: { line: 1, character: 2 },
        end: { line: 2, character: 2 },
    });
});
