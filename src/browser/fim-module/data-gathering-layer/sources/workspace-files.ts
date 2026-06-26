import URI from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { splitLines } from '../../../../common/text/crlf';
import { FimLogger } from '../../../../common/fim/logger';

const LOG = new FimLogger('browser:data-gathering:workspace-files');

export interface FileWindow {
    content: string;
    startLine: number;
    endLine: number;
}

@injectable()
export class FimWorkspaceFiles {
    @inject(FileService) protected readonly fileService!: FileService;
    @inject(WorkspaceService) protected readonly workspaceService!: WorkspaceService;

    relativePath(uri: URI): string {
        const roots = this.workspaceService.tryGetRoots();
        for (let i = 0; i < roots.length; i++) {
            const rel = roots[i].resource.relative(uri);
            if (rel) {
                const filePath = rel.toString();
                if (process.env.NODE_ENV === 'development') {
                    LOG.debug('FIM workspace-relative path resolved', { uri: uri.toString(), filePath });
                }
                return filePath;
            }
        }
        return uri.path.base;
    }

    async readWindow(uri: URI, centerLine0: number, radius: number): Promise<FileWindow | undefined> {
        try {
            const content = await this.fileService.read(uri);
            const lines = splitLines(content.value);
            const start = Math.max(0, centerLine0 - radius);
            const end = Math.min(lines.length - 1, centerLine0 + radius);
            return { content: joinLineRange(lines, start, end + 1), startLine: start, endLine: end };
        } catch (error) {
            LOG.warn('FIM file window read failed', { uri: uri.toString(), error: error instanceof Error ? error.message : String(error) });
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
