import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { SweepLogger } from '../../../../common/sweep/logger';
import { splitLines } from '../../../../common/text/crlf';

// Логгер утилиты файловых операций; нужен для диагностики того, какие пути и окна читаются для Sweep-контекста.
const LOG = new SweepLogger('browser:data-gathering:workspace-files');

// Срез файла с указанием строк; используется источниками контекста для передачи в SweepRelatedFile.
export interface FileWindow {
    content: string;
    startLine: number;
    endLine: number;
}

/** Предоставляет относительные пути и файловые окна всем источникам Sweep-контекста, чтобы они не дублировали файловый доступ. */
@injectable()
export class WorkspaceFiles {
    // Theia-сервис чтения файлов; нужен для получения содержимого окон и заголовков файлов.
    @inject(FileService) protected readonly fileService!: FileService;
    // Theia-сервис воркспейса; нужен для вычисления workspace-relative путей для Sweep file block заголовков.
    @inject(WorkspaceService) protected readonly workspaceService!: WorkspaceService;

    /**
     * Вычисляет workspace-relative путь URI, чтобы заголовки Sweep file-блоков содержали
     * короткие читаемые пути вместо полных file:// URI.
     */
    relativePath(uri: URI): string {
        for (const root of this.workspaceService.tryGetRoots()) {
            const rel = root.resource.relative(uri);
            if (rel) {
                const path = rel.toString();
                if (process.env.NODE_ENV === 'development') {
                    LOG.debug('Sweep workspace-relative path resolved', { uri: uri.toString(), path });
                }
                return path;
            }
        }
        if (process.env.NODE_ENV === 'development') {
            LOG.debug('Sweep workspace-relative path fallback used', { uri: uri.toString(), path: uri.path.base });
        }
        return uri.path.base;
    }

    /**
     * Читает окно файла вокруг указанной строки, чтобы источники контекста могли передать
     * релевантный фрагмент в related file блок Sweep-промпта без загрузки всего файла.
     */
    async readWindow(uri: URI, centerLine0: number, radius: number): Promise<FileWindow | undefined> {
        try {
            const content = await this.fileService.read(uri);
            const lines = splitLines(content.value);
            const start = Math.max(0, centerLine0 - radius);
            const end = Math.min(lines.length - 1, centerLine0 + radius);
            const window = { content: joinLineRange(lines, start, end + 1), startLine: start, endLine: end };
            if (process.env.NODE_ENV === 'development') {
                LOG.debug('Sweep file window read', { uri: uri.toString(), start, end, chars: window.content.length });
            }
            return window;
        } catch (error) {
            LOG.warn('Sweep file window read failed', { uri: uri.toString(), error: error instanceof Error ? error.message : String(error) });
            return undefined;
        }
    }

    /**
     * Читает начало файла когда точный диапазон символа неизвестен (SCM-источник);
     * заголовок файла достаточен для понимания его назначения моделью.
     */
    async readHead(uri: URI, maxLines: number): Promise<FileWindow | undefined> {
        try {
            const content = await this.fileService.read(uri);
            const lines = splitLines(content.value);
            const end = Math.min(lines.length - 1, Math.max(0, maxLines - 1));
            const window = { content: joinLineRange(lines, 0, end + 1), startLine: 0, endLine: end };
            if (process.env.NODE_ENV === 'development') {
                LOG.debug('Sweep file head read', { uri: uri.toString(), end, chars: window.content.length });
            }
            return window;
        } catch (error) {
            LOG.warn('Sweep file head read failed', { uri: uri.toString(), error: error instanceof Error ? error.message : String(error) });
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
