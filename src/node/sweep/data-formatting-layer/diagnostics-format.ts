import { DiagnosticDTO } from '../../../common/editor-dto';
import { SweepLogger } from '../../../common/sweep/logger';

// Логгер форматировщика диагностик; нужен для диагностики сколько маркеров попало в псевдофайл промпта.
const LOG = new SweepLogger('node:data-formatting:diagnostics-format');

/**
 * Форматирует диагностики в текст псевдофайла `diagnostics/{file}`;
 * errors идут первыми потому что модель должна приоритизировать их при выборе следующей правки.
 */
export function formatSweepDiagnosticsLines(diagnostics: DiagnosticDTO[]): string {
    const errorsFirst = diagnostics
        .slice()
        .sort((a, b) => severityRank(a) - severityRank(b) || a.range.start.line - b.range.start.line);
    const lines = new Array<string>(errorsFirst.length);
    for (let i = 0; i < errorsFirst.length; i++) {
        const d = errorsFirst[i];
        lines[i] = `Line ${d.range.start.line + 1}: ${d.message}`;
    }
    const text = lines.join('\n');
    LOG.info('Sweep diagnostics pseudo-file formatted', { diagnostics: diagnostics.length, chars: text.length });
    return text;
}

/**
 * Возвращает числовой приоритет severity чтобы sort поставил errors перед warnings;
 * чем меньше число тем выше приоритет в отсортированном списке.
 */
function severityRank(d: DiagnosticDTO): number {
    return d.severity === 'error' ? 0 : d.severity === 'warning' ? 1 : 2;
}
