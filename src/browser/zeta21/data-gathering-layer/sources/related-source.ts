import URI from '@theia/core/lib/common/uri';
import type { RelatedCandidate } from '../../../../common/zeta21/related-files';

// Контекст одного прохода сбора related-кандидатов одинаков для всех zeta21 source-реализаций и держит их на общей сигнатуре.
export interface RelatedSourceContext {
    languageId: string;
    uri: URI;
    position: { line: number; character: number };
    currentRelPath: string;
    queries: string[];
}

/** Источник related-кандидатов для zeta21 prefix-блоков; собирается в композит ZetaContextCollector. */
export interface RelatedSource {
    readonly id: string;
    collect(ctx: RelatedSourceContext): Promise<RelatedCandidate[]>;
}

/** DI-токен @multiInject; порядок биндингов определяет tie-break при равных score. */
export const ZetaRelatedSource = Symbol('ZetaRelatedSource');
