import URI from '@theia/core/lib/common/uri';
import { RelatedCandidate } from '../../../../common/sweep/related-files';

// Контекст одного прохода сбора related-кандидатов; одинаков для всех source-реализаций и держит их на общей сигнатуре.
export interface RelatedSourceContext {
    languageId: string;
    uri: URI;
    position: { line: number; character: number };
    currentRelPath: string;
    queries: string[];
}

/** Источник related-кандидатов для Sweep file-блоков; собирается в композит SweepContextCollector. */
export interface RelatedSource {
    readonly id: string;
    collect(ctx: RelatedSourceContext): Promise<RelatedCandidate[]>;
}

/** DI-токен @multiInject; порядок биндингов определяет tie-break при равных score. */
export const RelatedSource = Symbol('RelatedSource');
