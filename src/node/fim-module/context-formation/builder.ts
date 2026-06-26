import { Neighbor } from '../../../common/embedding-types';
import { FimModelId, GenerationMode } from '../../../common/model-types';
import { FileMode } from '../../../common/mode-types';
import { normalizeCrlf } from '../../util/crlf';
import { fimMaxTokens, fimStopTokens, getFimModelSpec } from './model-spec';
import { trimFimContext } from './semantic-trim';

export interface BuildFimPromptInput {
    modelId: FimModelId;
    fileMode: FileMode;
    prefix: string;
    suffix: string;
    generationMode: GenerationMode;
    contextSize: number;
    repoName?: string;
    filePath?: string;
    neighbors?: Neighbor[];
}

export interface BuiltFimPrompt {
    prompt: string;
    stop: string[];
    maxTokens: number;
    llamaModel: string;
}

export function buildFimPrompt(input: BuildFimPromptInput): BuiltFimPrompt {
    const spec = getFimModelSpec(input.modelId);
    const normalizedNeighbors = spec.supportsRepoContext ? normalizeNeighbors(input.neighbors ?? []) : [];
    const reservedChars = normalizedNeighbors.reduce((sum, n) => sum + n.text.length + n.filePath.length + 8, 0);
    const trimmed = trimFimContext(normalizeCrlf(input.prefix), normalizeCrlf(input.suffix), {
        fileMode: input.fileMode,
        contextSize: input.contextSize,
        reservedChars,
    });
    const fim = `${spec.tokens.prefix}${trimmed.prefix}${spec.tokens.suffix}${trimmed.suffix}${spec.tokens.middle}`;
    // Repo-уровневые слоты заполняются только при наличии реальных retrieval-соседей.
    // Без них фиктивные repo/file токены деградируют генерацию, поэтому используем file-level FIM.
    const useRepoContext = normalizedNeighbors.length > 0;
    return {
        prompt: useRepoContext
            ? renderRepoPrompt(spec.repoNameToken!, spec.fileToken!, input.repoName, input.filePath, normalizedNeighbors, fim)
            : fim,
        stop: fimStopTokens(spec),
        maxTokens: fimMaxTokens(input.generationMode),
        llamaModel: spec.llamaModel,
    };
}

function normalizeNeighbors(neighbors: Neighbor[]): Neighbor[] {
    return neighbors.map(neighbor => ({
        ...neighbor,
        text: normalizeCrlf(neighbor.text),
    }));
}

function renderRepoPrompt(
    repoNameToken: string,
    fileToken: string,
    repoName = 'workspace',
    filePath = 'current-file',
    neighbors: Neighbor[],
    currentFim: string,
): string {
    const chunks = [`${repoNameToken}${repoName}`];
    for (const neighbor of neighbors) {
        chunks.push(`${fileToken}${neighbor.filePath}\n${neighbor.text}`);
    }
    chunks.push(`${fileToken}${filePath}\n${currentFim}`);
    return chunks.join('\n');
}
