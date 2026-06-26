import { CallHierarchyServiceProvider } from '@theia/callhierarchy/lib/browser/callhierarchy-service';
import { CancellationToken } from '@theia/core/lib/common';
import { TypeHierarchyServiceProvider } from '@theia/typehierarchy/lib/browser/typehierarchy-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import URI from '@theia/core/lib/common/uri';
import { SweepLogger } from '../../../../common/sweep/logger';
import { RelatedCandidate } from '../../../../common/sweep/related-files';
import { WorkspaceFiles } from './workspace-files';

// Радиус окна вокруг найденного символа; достаточен чтобы показать модели контекст вызова или определения типа.
const WINDOW_RADIUS = 12;
// Ограничение числа элементов иерархии, чтобы популярные символы не захватывали весь бюджет related-файлов.
const MAX_ITEMS = 6;
// Логгер источника иерархии; нужен для диагностики доступности call/type hierarchy для текущего языка.
const LOG = new SweepLogger('browser:data-gathering:hierarchy-source');

// Минимальный тип для LSP-позиции из call/type hierarchy; нужен для приведения непрозрачных объектов провайдеров.
interface LspLikeItem {
    uri: { scheme: string; authority?: string; path: string; query?: string; fragment?: string };
    range: { start: { line: number } };
}

/** Использует call/type hierarchy LSP чтобы найти файлы-вызыватели и файлы с типами-предками для Sweep file-блоков. */
@injectable()
export class HierarchyRelatedSource {
    // Theia call hierarchy провайдер; нужен чтобы найти файлы где вызывается символ под курсором.
    @inject(CallHierarchyServiceProvider) protected readonly callProvider!: CallHierarchyServiceProvider;
    // Theia type hierarchy провайдер; нужен чтобы найти файлы с супер- и подтипами символа под курсором.
    @inject(TypeHierarchyServiceProvider) protected readonly typeProvider!: TypeHierarchyServiceProvider;
    // Утилита файловых операций; нужна для получения относительных путей и окон найденных файлов.
    @inject(WorkspaceFiles) protected readonly files!: WorkspaceFiles;

    /**
     * Объединяет результаты call-hierarchy и type-hierarchy в один список кандидатов,
     * чтобы Sweep получил наиболее семантически связанные файлы для контекста.
     */
    async collect(languageId: string, uri: URI, position: { line: number; character: number }, currentRelPath: string): Promise<RelatedCandidate[]> {
        const candidates: RelatedCandidate[] = [];
        await this.collectCallers(languageId, uri, position, currentRelPath, candidates);
        await this.collectTypes(languageId, uri, position, currentRelPath, candidates);
        LOG.info('Sweep hierarchy candidates collected', { languageId, candidates: candidates.length });
        return candidates;
    }

    /**
     * Добавляет файлы где вызывается символ под курсором; ошибки провайдера подавляются,
     * чтобы отсутствие call hierarchy не блокировало Sweep-предсказание.
     */
    private async collectCallers(languageId: string, uri: URI, position: { line: number; character: number }, currentRelPath: string, out: RelatedCandidate[]): Promise<void> {
        try {
            const service = this.callProvider.get(languageId, uri);
            if (!service) {
                return;
            }
            const session = await service.getRootDefinition(uri.toString(), position, CancellationToken.None);
            if (!session) {
                return;
            }
            for (let i = 0; i < session.items.length && i < MAX_ITEMS; i++) {
                const item = session.items[i];
                const callers = (await service.getCallers(item, CancellationToken.None)) ?? [];
                for (let j = 0; j < callers.length && j < MAX_ITEMS; j++) {
                    const caller = callers[j];
                    await this.pushItem(caller.from as unknown as LspLikeItem, currentRelPath, out);
                }
            }
            session.dispose();
        } catch (error) {
            if (process.env.NODE_ENV === 'development') {
                LOG.debug('Sweep call hierarchy unavailable', { languageId, error: error instanceof Error ? error.message : String(error) });
            }
        }
    }

    /**
     * Добавляет файлы с суперклассами и подтипами символа; ошибки провайдера подавляются,
     * чтобы отсутствие type hierarchy не блокировало Sweep-предсказание.
     */
    private async collectTypes(languageId: string, uri: URI, position: { line: number; character: number }, currentRelPath: string, out: RelatedCandidate[]): Promise<void> {
        try {
            const service = this.typeProvider.get(languageId, uri);
            if (!service) {
                return;
            }
            const session = await service.prepareSession(uri.toString(), position, CancellationToken.None);
            if (!session) {
                return;
            }
            for (let i = 0; i < session.items.length && i < MAX_ITEMS; i++) {
                const item = session.items[i];
                if (item._sessionId === undefined || item._itemId === undefined) {
                    continue;
                }
                const supers = (await service.provideSuperTypes(item._sessionId, item._itemId, CancellationToken.None)) ?? [];
                const subs = (await service.provideSubTypes(item._sessionId, item._itemId, CancellationToken.None)) ?? [];
                let pushed = 0;
                for (let j = 0; j < supers.length && pushed < MAX_ITEMS; j++, pushed++) {
                    await this.pushItem(supers[j] as unknown as LspLikeItem, currentRelPath, out);
                }
                for (let j = 0; j < subs.length && pushed < MAX_ITEMS; j++, pushed++) {
                    await this.pushItem(subs[j] as unknown as LspLikeItem, currentRelPath, out);
                }
            }
            session.dispose();
        } catch (error) {
            if (process.env.NODE_ENV === 'development') {
                LOG.debug('Sweep type hierarchy unavailable', { languageId, error: error instanceof Error ? error.message : String(error) });
            }
        }
    }

    /**
     * Читает файловое окно вокруг одного hierarchy-элемента и добавляет его в список кандидатов;
     * пропускает текущий файл чтобы не дублировать уже имеющийся в промпте контекст.
     */
    private async pushItem(item: LspLikeItem, currentRelPath: string, out: RelatedCandidate[]): Promise<void> {
        const uri = new URI(monaco.Uri.from(item.uri as monaco.UriComponents).toString());
        const rel = this.files.relativePath(uri);
        if (!rel || rel === currentRelPath) {
            return;
        }
        const window = await this.files.readWindow(uri, item.range.start.line, WINDOW_RADIUS);
        if (window) {
            out.push({ filePath: rel, content: window.content, startLine: window.startLine, endLine: window.endLine, score: 1 });
        }
    }
}
