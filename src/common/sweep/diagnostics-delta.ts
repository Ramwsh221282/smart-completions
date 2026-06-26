import type { PositionDTO, RangeDTO } from '../editor-dto';

/** Вычисляет post-apply range вставленного текста для точного обратного edit без undo. */
export function rangeAfterInsertedText(start: PositionDTO, newText: string): RangeDTO {
    let line = start.line;
    let character = start.character;
    for (let i = 0; i < newText.length; i++) {
        const code = newText.charCodeAt(i);
        if (code === 13) {
            line++;
            character = 0;
            if (newText.charCodeAt(i + 1) === 10) {
                i++;
            }
        } else if (code === 10) {
            line++;
            character = 0;
        } else {
            character++;
        }
    }
    return { start: { line: start.line, character: start.character }, end: { line, character } };
}
