// Pure Monaco-to-DTO mappers for document sync. Kept free of the monaco import
// so they can be unit-tested in Node without a browser runtime.

import {
    CoreDocumentChange,
    CoreFileMode,
    CoreInitialDocumentSnapshot,
    CoreTextChange,
} from '../../common/core/core-protocol';

/** Minimal Monaco range shape (1-based line/column). */
export interface MonacoRangeLike {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
}

/** Minimal Monaco content-change shape. */
export interface MonacoChangeLike {
    range: MonacoRangeLike;
    rangeLength: number;
    text: string;
}

/** Minimal Monaco model snapshot shape. */
export interface ModelSnapshotLike {
    uri: string;
    version: number;
    languageId: string;
    scheme: string;
    filePath?: string;
    text: string;
}

/** Prose languages relax trigger rules and disable code-only context. */
export function fileModeForLanguage(languageId: string): CoreFileMode {
    return languageId === 'markdown' || languageId === 'plaintext' ? 'prose' : 'code';
}

/** Builds an initial snapshot DTO from a model snapshot. */
export function toCoreInitialSnapshot(model: ModelSnapshotLike): CoreInitialDocumentSnapshot {
    return {
        uri: model.uri,
        version: model.version,
        languageId: model.languageId,
        filePath: model.filePath,
        fileMode: fileModeForLanguage(model.languageId),
        kind: model.scheme === 'untitled' ? 'untitled' : 'file',
        text: model.text,
    };
}

/** Builds a content-change DTO from a Monaco change. */
export function toCoreTextChange(change: MonacoChangeLike): CoreTextChange {
    return {
        range: {
            startLineNumber: change.range.startLineNumber,
            startColumn: change.range.startColumn,
            endLineNumber: change.range.endLineNumber,
            endColumn: change.range.endColumn,
        },
        rangeLength: change.rangeLength,
        text: change.text,
    };
}

/** Builds a change batch DTO from a Monaco change event. */
export function toCoreDocumentChange(
    uri: string,
    versionId: number,
    changes: readonly MonacoChangeLike[],
): CoreDocumentChange {
    return {
        uri,
        fromVersion: versionId - 1,
        toVersion: versionId,
        changes: changes.map(toCoreTextChange),
    };
}
