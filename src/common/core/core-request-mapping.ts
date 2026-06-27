import type {
    CoreCompletionRequest,
    CoreCursor,
    CoreDiagnostic,
    CoreFileMode,
    CoreIndexedRange,
    CoreMode,
    CoreOutlineItem,
    CoreRelatedFileHint,
    CoreSignals,
} from './core-protocol';
import type { RecentEdit } from '../edit-history-types';

/** Raw frontend context carried into the core envelope builder. */
export interface CoreRequestContextEnvelope {
    recentEdits: RecentEdit[];
    diagnostics: CoreDiagnostic[];
    outline: CoreOutlineItem[];
    relatedFileHints: CoreRelatedFileHint[];
    signals?: CoreSignals;
}

/** Input required to assemble one core completion request. */
export interface BuildCoreCompletionRequestParams {
    requestId: number;
    mode: CoreMode;
    modelId: string;
    uri: string;
    version: number;
    languageId: string;
    fileMode: CoreFileMode;
    cursor: CoreCursor;
    editableRegion?: CoreIndexedRange;
    configVersion: number;
    configJson?: string;
    context: CoreRequestContextEnvelope;
}

/** Builds a full CoreCompletionRequest from already-collected frontend context. */
export function buildCoreCompletionRequest(
    params: BuildCoreCompletionRequestParams,
): CoreCompletionRequest {
    return {
        requestId: params.requestId,
        mode: params.mode,
        modelId: params.modelId,
        uri: params.uri,
        version: params.version,
        languageId: params.languageId,
        fileMode: params.fileMode,
        cursor: params.cursor,
        editableRegion: params.editableRegion,
        recentEditUris: recentEditUris(params.context.recentEdits),
        diagnostics: params.context.diagnostics,
        outline: params.context.outline,
        relatedFileHints: params.context.relatedFileHints,
        signals: params.context.signals,
        configVersion: params.configVersion,
        configJson: params.configJson,
    };
}

function recentEditUris(recentEdits: readonly RecentEdit[]): string[] {
    const seen = new Set<string>();
    const uris: string[] = [];
    for (let i = 0; i < recentEdits.length; i++) {
        const uri = recentEdits[i].uri;
        if (!seen.has(uri)) {
            seen.add(uri);
            uris.push(uri);
        }
    }
    return uris;
}
