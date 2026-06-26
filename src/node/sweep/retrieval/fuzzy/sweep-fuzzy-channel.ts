import { injectable } from '@theia/core/shared/inversify';
import fuzzysort from 'fuzzysort';
import type { Neighbor } from '../../../../common/embedding-types';
import type { SymbolRow } from '../graph/sweep-graph-store';
import { splitIdentifier } from './identifier-tokenize';

/** Максимум fuzzy hits на один edit-signal символ ограничивает CPU и шум в candidate pool. */
const FUZZY_PER_SYMBOL = 8;

/** Минимальный fuzzysort score сохраняет опечатки, но отсекает нерелевантные короткие совпадения. */
const FUZZY_THRESHOLD = 0.35;

export interface FuzzyEntry {
    name: string;
    kind: string;
    file: string;
    startLine: number;
    endLine: number;
    body: string;
    prepared: Fuzzysort.Prepared;
}

/** Sweep fuzzy channel держит in-memory каталог symbol names для быстрых typo/short-name совпадений. */
@injectable()
export class SweepFuzzyChannel {
    private entries: FuzzyEntry[] = [];

    /** Полностью перестраивает каталог из SQLite graph после full index или restore. */
    rebuild(symbols: SymbolRow[]): void {
        const entries = new Array<FuzzyEntry>(symbols.length);
        for (let i = 0; i < symbols.length; i++) {
            entries[i] = this.entryFromSymbol(symbols[i]);
        }
        this.entries = entries;
    }

    /** Инкрементально заменяет symbols одного файла после live/disk reindex. */
    updateFile(file: string, symbols: SymbolRow[]): void {
        const kept: FuzzyEntry[] = [];
        for (let i = 0; i < this.entries.length; i++) {
            const entry = this.entries[i];
            if (entry.file !== file) {
                kept.push(entry);
            }
        }
        for (let i = 0; i < symbols.length; i++) {
            kept.push(this.entryFromSymbol(symbols[i]));
        }
        this.entries = kept;
    }

    /** Удаляет symbols файла из каталога при удалении или закрытии dirty buffer с откатом к отсутствующему файлу. */
    removeFile(file: string): void {
        const kept: FuzzyEntry[] = [];
        for (let i = 0; i < this.entries.length; i++) {
            const entry = this.entries[i];
            if (entry.file !== file) {
                kept.push(entry);
            }
        }
        this.entries = kept;
    }

    /** Ищет fuzzy matches по edit-signal symbols и возвращает готовые Neighbor blocks для общего merge. */
    retrieve(querySymbols: string[], topN: number): Neighbor[] {
        if (this.entries.length === 0 || topN <= 0) {
            return [];
        }
        const out: Neighbor[] = [];
        const seen = new Set<string>();
        const queries = expandQuerySymbols(querySymbols);
        for (let i = 0; i < queries.length && out.length < topN; i++) {
            const hits = fuzzysort.go(queries[i], this.entries, { key: 'name', limit: FUZZY_PER_SYMBOL, threshold: FUZZY_THRESHOLD });
            for (let j = 0; j < hits.length && out.length < topN; j++) {
                const entry = hits[j].obj;
                const key = `${entry.file}:${entry.startLine}:${entry.endLine}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    out.push({ filePath: entry.file, startLine: entry.startLine, endLine: entry.endLine, text: entry.body, score: hits[j].score });
                }
            }
        }
        return out;
    }

    /** Создаёт prepared fuzzy entry с фиксированной формой объекта для стабильного hot-path доступа. */
    private entryFromSymbol(symbol: SymbolRow): FuzzyEntry {
        return {
            name: symbol.name,
            kind: symbol.kind,
            file: symbol.file,
            startLine: symbol.startLine,
            endLine: symbol.endLine,
            body: symbol.body,
            prepared: fuzzysort.prepare(symbol.name),
        };
    }
}

/** Расширяет query symbols под-токенами identifiers и дедуплицирует с сохранением порядка. */
function expandQuerySymbols(symbols: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < symbols.length; i++) {
        const parts = splitIdentifier(symbols[i]);
        for (let j = 0; j < parts.length; j++) {
            const key = parts[j].toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                out.push(parts[j]);
            }
        }
    }
    return out;
}
