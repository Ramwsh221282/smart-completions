import { Chunk } from './chunk-meta';
import { isCodeLanguage } from './language-registry';
import { TreeSitterChunker } from './tree-sitter-chunker';
import { chunkProse } from './prose-chunker';

/**
 * Единый диспетчер чанкования: код (tree-sitter) или проза (fallback).
 * Режим определяется по наличию tree-sitter грамматики для languageId.
 */
export class Chunker {
    private readonly codeChunker = new TreeSitterChunker();

    async chunk(filePath: string, source: string, languageId: string): Promise<Chunk[]> {
        if (isCodeLanguage(languageId)) {
            const codeChunks = await this.codeChunker.chunk(filePath, source, languageId);
            if (codeChunks.length > 0) {
                return codeChunks;
            }
            // Пустой/нераспознанный код → fallback на прозу, чтобы файл всё равно проиндексировался.
        }
        return chunkProse(filePath, source, languageId);
    }
}
