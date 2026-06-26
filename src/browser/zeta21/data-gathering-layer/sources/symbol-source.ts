import { injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import { StandaloneServices } from '@theia/monaco-editor-core/esm/vs/editor/standalone/browser/standaloneServices';
import { ILanguageFeaturesService } from '@theia/monaco-editor-core/esm/vs/editor/common/services/languageFeatures';
import { extractCodeSymbolsHeuristic, type OutlineSymbol } from '../../../../common/sweep/outline';
import { ZetaLogger } from '../../../../common/zeta21/logger';

// Логгер источника символов нужен для диагностики того, откуда получен outline: от LSP или от эвристики.
const LOG = new ZetaLogger('browser:data-gathering:symbol-source');

// Заглушка токена отмены нужна для вызова LSP-провайдеров, у которых API требует токен, но zeta21 не отменяет outline-запросы.
const NO_CANCEL = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose(): void {} }) };

// Внутренняя форма символа от Monaco LSP-провайдеров до маппинга в OutlineSymbol.
interface RawSymbol {
    name: string;
    kind: number;
    range: { startLineNumber: number; endLineNumber: number; startColumn: number };
    children?: RawSymbol[];
}

/** Получает структуру файла для outline-эвристик и будущего синтаксического расширения региона; приоритет у LSP, fallback — эвристика. */
@injectable()
export class SymbolSource {
    /** Пробует получить символы от LSP и при их отсутствии переключается на эвристику, чтобы zeta21 не зависел от наличия language server. */
    async symbols(model: monaco.editor.ITextModel): Promise<OutlineSymbol[]> {
        const lsp = await this.lspSymbols(model);
        if (lsp.length > 0) {
            LOG.info('Zeta symbols collected from LSP', { count: lsp.length, uri: model.uri.toString() });
            return lsp;
        }
        const fallback = extractCodeSymbolsHeuristic(model.getValue());
        LOG.info('Zeta symbols collected from heuristic fallback', { count: fallback.length, uri: model.uri.toString() });
        return fallback;
    }

    /** Запрашивает Monaco document symbol провайдеры и возвращает первый непустой результат, не давая ошибкам LSP ломать trigger. */
    private async lspSymbols(model: monaco.editor.ITextModel): Promise<OutlineSymbol[]> {
        try {
            const features = StandaloneServices.get(ILanguageFeaturesService) as unknown as {
                documentSymbolProvider: { ordered(m: monaco.editor.ITextModel): Array<{ provideDocumentSymbols(m: monaco.editor.ITextModel, token: unknown): unknown }> };
            };
            const providers = features.documentSymbolProvider.ordered(model);
            for (let i = 0; i < providers.length; i++) {
                const result = (await providers[i].provideDocumentSymbols(model, NO_CANCEL)) as RawSymbol[] | null | undefined;
                if (result && result.length > 0) {
                    return mapSymbols(result);
                }
            }
        } catch (error) {
            if (process.env.NODE_ENV === 'development') {
                LOG.debug('Zeta LSP symbols unavailable', { error: error instanceof Error ? error.message : String(error) });
            }
        }
        return [];
    }
}

function symbolKindName(kind: number): string {
    const name = (monaco.languages.SymbolKind as unknown as Record<number, string>)[kind];
    return typeof name === 'string' ? name.toLowerCase() : 'symbol';
}

function mapSymbols(list: RawSymbol[]): OutlineSymbol[] {
    const out = new Array<OutlineSymbol>(list.length);
    for (let i = 0; i < list.length; i++) {
        const symbol = list[i];
        out[i] = {
            name: symbol.name,
            kind: symbolKindName(symbol.kind),
            startLine: symbol.range.startLineNumber - 1,
            endLine: symbol.range.endLineNumber - 1,
            startChar: symbol.range.startColumn - 1,
            children: symbol.children?.length ? mapSymbols(symbol.children) : undefined,
        };
    }
    return out;
}
