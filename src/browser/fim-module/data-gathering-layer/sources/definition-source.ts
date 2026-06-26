import URI from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import { StandaloneServices } from '@theia/monaco-editor-core/esm/vs/editor/standalone/browser/standaloneServices';
import { ILanguageFeaturesService } from '@theia/monaco-editor-core/esm/vs/editor/common/services/languageFeatures';
import type { RelatedCandidate } from '../../../../common/zeta21/related-files';
import { FimLogger } from '../../../../common/fim/logger';
import { FimWorkspaceFiles } from './workspace-files';

const LOG = new FimLogger('browser:data-gathering:definition-source');
const WINDOW_RADIUS = 12;
const MAX_DEFINITIONS = 6;
const NO_CANCEL = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose(): void {} }) };

export interface FimDefinitionSourceContext {
    uri: URI;
    position: { line: number; character: number };
    currentRelPath: string;
}

@injectable()
export class FimDefinitionRelatedSource {
    @inject(FimWorkspaceFiles) protected readonly files!: FimWorkspaceFiles;

    async collect(ctx: FimDefinitionSourceContext): Promise<RelatedCandidate[]> {
        const model = monaco.editor.getModel(monaco.Uri.parse(ctx.uri.toString()));
        if (!model) {
            return [];
        }
        const features = StandaloneServices.get(ILanguageFeaturesService) as unknown as {
            definitionProvider: { ordered(m: monaco.editor.ITextModel): Array<{ provideDefinition(m: monaco.editor.ITextModel, p: monaco.Position, t: unknown): unknown }> };
        };
        const position = new monaco.Position(ctx.position.line + 1, ctx.position.character + 1);
        const out: RelatedCandidate[] = [];
        const seen = new Set<string>();
        const providers = features.definitionProvider.ordered(model);
        for (let i = 0; i < providers.length; i++) {
            const result = (await providers[i].provideDefinition(model, position, NO_CANCEL)) as Array<{ uri: monaco.Uri; range: monaco.IRange }> | null | undefined;
            if (!result || result.length === 0) {
                continue;
            }
            for (let j = 0; j < result.length && out.length < MAX_DEFINITIONS; j++) {
                await this.pushDefinition(result[j], ctx.currentRelPath, seen, out);
            }
            if (out.length > 0) {
                break;
            }
        }
        LOG.info('FIM definition candidates collected', { candidates: out.length });
        return out;
    }

    private async pushDefinition(definition: { uri: monaco.Uri; range: monaco.IRange }, currentRel: string, seen: Set<string>, out: RelatedCandidate[]): Promise<void> {
        const uri = new URI(definition.uri.toString());
        const rel = this.files.relativePath(uri);
        if (!rel || rel === currentRel || seen.has(rel)) {
            return;
        }
        seen.add(rel);
        const window = await this.files.readWindow(uri, definition.range.startLineNumber - 1, WINDOW_RADIUS);
        if (window) {
            out.push({ filePath: rel, content: window.content, startLine: window.startLine, endLine: window.endLine, score: 2 });
        }
    }
}
