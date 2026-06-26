import * as path from 'node:path';
import type { Neighbor } from '../../../common/embedding-types';
import { renderExcerpt } from '../../../common/zeta21/excerpt';
import { dedupeContextFiles } from '../../../common/zeta21/dedup-context';
import type { ZetaRelatedFile } from '../../../common/zeta21/types';
import { sweepGrammarForLanguage, sweepLanguageIdForExtension } from '../../sweep/retrieval/graph/sweep-language-registry';
import { SweepTreeSitter } from '../../sweep/retrieval/graph/sweep-tree-sitter-loader';

// Shared tree-sitter loader amortizes WASM and grammar initialization across zeta21 requests and excerpt tests.
const TREE_SITTER = new SweepTreeSitter();

/** Сливает frontend related и backend neighbors в единый excerpt-поток, удаляя дубли до prompt trimming. */
export async function renderRelatedExcerpts(related: ZetaRelatedFile[], neighbors: Neighbor[], currentFilePath: string): Promise<ZetaRelatedFile[]> {
    const relatedWithNeighbors = mapNeighbors(neighbors);
    const deduped = dedupeContextFiles({
        currentFilePath,
        neighbors,
        relatedFiles: concatRelated(related, relatedWithNeighbors),
    }).relatedFiles;
    const rendered = new Array<ZetaRelatedFile>(deduped.length);
    for (let i = 0; i < deduped.length; i++) {
        const file = deduped[i];
        rendered[i] = { ...file, content: await maybeRenderExcerpt(file.filePath, file.content) };
    }
    return rendered;
}

function mapNeighbors(neighbors: Neighbor[]): ZetaRelatedFile[] {
    const out = new Array<ZetaRelatedFile>(neighbors.length);
    for (let i = 0; i < neighbors.length; i++) {
        out[i] = { filePath: neighbors[i].filePath, content: neighbors[i].text, score: neighbors[i].score };
    }
    return out;
}

function concatRelated(primary: ZetaRelatedFile[], secondary: ZetaRelatedFile[]): ZetaRelatedFile[] {
    const out = new Array<ZetaRelatedFile>(primary.length + secondary.length);
    let write = 0;
    for (let i = 0; i < primary.length; i++) {
        out[write++] = primary[i];
    }
    for (let i = 0; i < secondary.length; i++) {
        out[write++] = secondary[i];
    }
    return out;
}

async function maybeRenderExcerpt(filePath: string, content: string): Promise<string> {
    const languageId = sweepLanguageIdForExtension(path.extname(filePath));
    const grammar = sweepGrammarForLanguage(languageId);
    if (!grammar) {
        return content;
    }
    try {
        const parser = await TREE_SITTER.ensureInit();
        parser.setLanguage((await TREE_SITTER.loadLanguage(grammar)) as Parameters<typeof parser.setLanguage>[0]);
        const tree = parser.parse(content);
        return renderExcerpt(content, tree.rootNode);
    } catch {
        return content;
    }
}
