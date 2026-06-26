import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { splitLines } from '../../../../common/text/crlf';
import { ZetaLogger } from '../../../../common/zeta21/logger';

// Логгер утилиты файловых операций нужен для диагностики того, какие пути и окна читаются для zeta21 контекста.
const LOG = new ZetaLogger('browser:data-gathering:workspace-files');

// Срез файла с указанием строк используется источниками контекста для передачи в ZetaRelatedFile.
export interface FileWindow {
    content: string;
    startLine: number;
    endLine: number;
}

/** Предоставляет относительные пути и файловые окна всем источникам zeta21-контекста, чтобы они не дублировали файловый доступ. */
@injectable()
export class WorkspaceFiles {
    @inject(FileService) protected readonly fileService!: FileService;
    @inject(WorkspaceService) protected readonly workspaceService!: WorkspaceService;

    /** Вычисляет workspace-relative путь URI, чтобы `<filename>` заголовки Zeta были короткими и читаемыми. */
    relativePath(uri: URI): string {
        const roots = this.workspaceService.tryGetRoots();
        for (let i = 0; i < roots.length; i++) {
            const rel = roots[i].resource.relative(uri);
            if (rel) {
                const path = rel.toString();
                if (process.env.NODE_ENV === 'development') {
                    LOG.debug('Zeta workspace-relative path resolved', { uri: uri.toString(), path });
                }
                return path;
            }
        }
        if (process.env.NODE_ENV === 'development') {
            LOG.debug('Zeta workspace-relative path fallback used', { uri: uri.toString(), path: uri.path.base });
        }
        return uri.path.base;
    }

    /** Читает окно файла вокруг указанной строки, чтобы related-source отдавал модели локальный контекст вместо всего файла. */
    async readWindow(uri: URI, centerLine0: number, radius: number): Promise<FileWindow | undefined> {
        try {
            const content = await this.fileService.read(uri);
            const lines = splitLines(content.value);
            const start = Math.max(0, centerLine0 - radius);
            const end = Math.min(lines.length - 1, centerLine0 + radius);
            const window = { content: joinLineRange(lines, start, end + 1), startLine: start, endLine: end };
            if (process.env.NODE_ENV === 'development') {
                LOG.debug('Zeta file window read', { uri: uri.toString(), start, end, chars: window.content.length });
            }
            return window;
        } catch (error) {
            LOG.warn('Zeta file window read failed', { uri: uri.toString(), error: error instanceof Error ? error.message : String(error) });
            return undefined;
        }
    }

    /** Читает начало файла когда точный диапазон символа неизвестен, а related-source достаточно заголовка для классификации файла. */
    async readHead(uri: URI, maxLines: number): Promise<FileWindow | undefined> {
        try {
            const content = await this.fileService.read(uri);
            const lines = splitLines(content.value);
            const end = Math.min(lines.length - 1, Math.max(0, maxLines - 1));
            const window = { content: joinLineRange(lines, 0, end + 1), startLine: 0, endLine: end };
            if (process.env.NODE_ENV === 'development') {
                LOG.debug('Zeta file head read', { uri: uri.toString(), end, chars: window.content.length });
            }
            return window;
        } catch (error) {
            LOG.warn('Zeta file head read failed', { uri: uri.toString(), error: error instanceof Error ? error.message : String(error) });
            return undefined;
        }
    }
}

function joinLineRange(lines: string[], start: number, endExclusive: number): string {
    const end = Math.min(lines.length, endExclusive);
    if (start >= end) {
        return '';
    }
    let out = lines[start];
    for (let i = start + 1; i < end; i++) {
        out += `\n${lines[i]}`;
    }
    return out;
}
