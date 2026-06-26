import { injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import { StandaloneServices } from '@theia/monaco-editor-core/esm/vs/editor/standalone/browser/standaloneServices';
import { ILanguageFeaturesService } from '@theia/monaco-editor-core/esm/vs/editor/common/services/languageFeatures';
import { OutlineSymbol, extractCodeSymbolsHeuristic } from '../../../../common/sweep/outline';
import { SweepLogger } from '../../../../common/sweep/logger';

// Логгер источника символов; нужен для диагностики того, откуда получен outline — от LSP или от эвристики.
const LOG = new SweepLogger('browser:data-gathering:symbol-source');
// Заглушка токена отмены; нужна для вызова LSP-провайдеров у которых API требует токен, но Sweep не отменяет outline-запросы.
const NO_CANCEL = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose(): void {} }) };

// Внутренняя форма символа от Monaco LSP-провайдеров до маппинга в OutlineSymbol.
interface RawSymbol {
    name: string;
    kind: number;
    range: { startLineNumber: number; endLineNumber: number; startColumn: number };
    children?: RawSymbol[];
}

/**
 * Преобразует числовой SymbolKind Monaco в читаемое имя, чтобы outline псевдофайл
 * содержал понятные типы символов вместо числовых кодов.
 */
function symbolKindName(kind: number): string {
    const name = (monaco.languages.SymbolKind as unknown as Record<number, string>)[kind];
    return typeof name === 'string' ? name.toLowerCase() : 'symbol';
}

/**
 * Конвертирует сырые LSP-символы Monaco в единый формат OutlineSymbol,
 * чтобы formatOutline мог работать с одним типом независимо от источника.
 */
function mapSymbols(list: RawSymbol[]): OutlineSymbol[] {
    const out = new Array<OutlineSymbol>(list.length);
    for (let i = 0; i < list.length; i++) {
        const s = list[i];
        out[i] = {
            name: s.name,
            kind: symbolKindName(s.kind),
            startLine: s.range.startLineNumber - 1,
            endLine: s.range.endLineNumber - 1,
            startChar: s.range.startColumn - 1,
            children: s.children?.length ? mapSymbols(s.children) : undefined,
        };
    }
    return out;
}

/** Получает структуру файла для outline/ псевдофайла Sweep-промпта; приоритет у LSP, fallback — эвристический парсер. */
@injectable()
export class SymbolSource {
    /**
     * Пробует получить символы от LSP-провайдеров и при их отсутствии переключается
     * на регулярный парсер, чтобы outline был доступен даже без языкового сервера.
     */
    async symbols(model: monaco.editor.ITextModel): Promise<OutlineSymbol[]> {
        const lsp = await this.lspSymbols(model);
        if (lsp.length > 0) {
            LOG.info('Sweep symbols collected from LSP', { count: lsp.length, uri: model.uri.toString() });
            return lsp;
        }
        const fallback = extractCodeSymbolsHeuristic(model.getValue());
        LOG.info('Sweep symbols collected from heuristic fallback', { count: fallback.length, uri: model.uri.toString() });
        return fallback;
    }

    /**
     * Запрашивает Monaco document symbol провайдеры и возвращает первый непустой результат;
     * ошибки провайдеров подавляются чтобы outline не блокировал Sweep-предсказание.
     */
    private async lspSymbols(model: monaco.editor.ITextModel): Promise<OutlineSymbol[]> {
        try {
            const features = StandaloneServices.get(ILanguageFeaturesService) as unknown as {
                documentSymbolProvider: { ordered(m: monaco.editor.ITextModel): Array<{ provideDocumentSymbols(m: monaco.editor.ITextModel, token: unknown): unknown }> };
            };
            for (const provider of features.documentSymbolProvider.ordered(model)) {
                const result = (await provider.provideDocumentSymbols(model, NO_CANCEL)) as RawSymbol[] | null | undefined;
                if (result && result.length > 0) {
                    return mapSymbols(result);
                }
            }
        } catch (error) {
            if (process.env.NODE_ENV === 'development') {
                LOG.debug('Sweep LSP symbols unavailable', { error: error instanceof Error ? error.message : String(error) });
            }
        }
        return [];
    }
}
