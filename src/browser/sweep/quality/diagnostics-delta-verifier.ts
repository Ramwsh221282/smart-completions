import { injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import type { DiagnosticsGateConfig } from '../../../common/nes-types';
import type { RangeDTO, TextEditDTO } from '../../../common/editor-dto';
import { rangeAfterInsertedText } from '../../../common/sweep/diagnostics-delta';
import { SweepLogger } from '../../../common/sweep/logger';

/** Логгер post-apply verifier нужен для аудита warn/revert решений без блокировки accept path. */
const LOG = new SweepLogger('browser:sweep:diagnostics-delta');

export interface DiagnosticsDeltaSnapshot {
    uri: string;
    beforeErrors: number;
    beforeVersion: number;
    inverseEdit: TextEditDTO;
}

/** Проверяет LSP error-delta после accept и fail-open реагирует warn/revert режимом. */
@injectable()
export class DiagnosticsDeltaVerifier {
    /** Снимает error-счётчик и обратную правку до применения NES edit. */
    snapshotBefore(model: monaco.editor.ITextModel, edit: TextEditDTO): DiagnosticsDeltaSnapshot {
        const oldText = model.getValueInRange(toMonacoRange(edit.range));
        return {
            uri: model.uri.toString(),
            beforeErrors: countErrors(model.uri),
            beforeVersion: model.getVersionId(),
            inverseEdit: {
                range: rangeAfterInsertedText(edit.range.start, edit.newText),
                newText: oldText,
            },
        };
    }

    /** После accept ждёт settle маркеров и реагирует fail-open по diagnosticsGate config. */
    async verify(editor: monaco.editor.ICodeEditor, snapshot: DiagnosticsDeltaSnapshot, acceptedVersion: number, config: DiagnosticsGateConfig): Promise<void> {
        const model = editor.getModel();
        if (!model || model.uri.toString() !== snapshot.uri) {
            return;
        }
        const afterErrors = await settleErrors(model.uri, config.settleTimeoutMs, config.settleMs);
        if (afterErrors === undefined || afterErrors <= snapshot.beforeErrors) {
            return;
        }
        if (config.mode === 'warn') {
            LOG.info('NES edit raised diagnostics', { before: snapshot.beforeErrors, after: afterErrors });
            return;
        }
        if (model.getVersionId() !== acceptedVersion) {
            return;
        }
        editor.executeEdits('smart-completions-nes-diagnostics-revert', [toMonacoEdit(snapshot.inverseEdit)]);
        LOG.info('NES edit reverted by diagnostics verifier', { before: snapshot.beforeErrors, after: afterErrors });
    }
}

/** Считает только Error-маркеры для всего файла, чтобы range shifts не ломали диагностику. */
export function countErrors(uri: monaco.Uri): number {
    const markers = monaco.editor.getModelMarkers({ resource: uri });
    let count = 0;
    for (let i = 0; i < markers.length; i++) {
        if (markers[i].severity === monaco.MarkerSeverity.Error) {
            count++;
        }
    }
    return count;
}

/** Ждёт тишины marker updates после первого события по target uri или fail-open timeout. */
export function settleErrors(uri: monaco.Uri, settleTimeoutMs: number, settleMs: number): Promise<number | undefined> {
    const target = uri.toString();
    const safeTimeout = Math.max(1, settleTimeoutMs);
    const safeSettle = Math.max(0, settleMs);
    return new Promise(resolve => {
        let settled = false;
        let settleTimer: ReturnType<typeof setTimeout> | undefined;
        const subscription = monaco.editor.onDidChangeMarkers(resources => {
            for (let i = 0; i < resources.length; i++) {
                if (resources[i].toString() === target) {
                    if (settleTimer) {
                        clearTimeout(settleTimer);
                    }
                    settleTimer = setTimeout(() => finish(countErrors(uri)), safeSettle);
                    break;
                }
            }
        });
        const timeout = setTimeout(() => finish(undefined), safeTimeout);
        const finish = (value: number | undefined): void => {
            if (settled) {
                return;
            }
            settled = true;
            subscription.dispose();
            clearTimeout(timeout);
            if (settleTimer) {
                clearTimeout(settleTimer);
            }
            resolve(value);
        };
    });
}

/** Конвертирует протокольный range в Monaco Range для чтения старого текста. */
export function toMonacoRange(range: RangeDTO): monaco.Range {
    return new monaco.Range(
        range.start.line + 1,
        range.start.character + 1,
        range.end.line + 1,
        range.end.character + 1,
    );
}

/** Конвертирует обратный TextEditDTO в Monaco edit operation для безопасного revert. */
function toMonacoEdit(edit: TextEditDTO): monaco.editor.IIdentifiedSingleEditOperation {
    return {
        range: toMonacoRange(edit.range),
        text: edit.newText,
        forceMoveMarkers: true,
    };
}
