import { ChunkRecord, VectorHit } from './iface';

// Классический BM25 (k1=1.5, b=0.75) с инвертированным индексом.
// Лексическая половина гибридного поиска — store-agnostic (как в dhi).
const K1 = 1.5;
const B = 0.75;
const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

interface Doc {
    record: ChunkRecord;
    length: number;
    tf: Map<string, number>;
}

function tokenize(text: string): string[] {
    const out: string[] = [];
    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(text)) !== null) {
        out.push(m[0].toLowerCase());
    }
    return out;
}

export class Bm25Index {
    private readonly docs = new Map<string, Doc>();
    private readonly postings = new Map<string, Set<string>>();
    private readonly df = new Map<string, number>();
    private totalLength = 0;

    get size(): number {
        return this.docs.size;
    }

    add(records: ChunkRecord[]): void {
        for (const record of records) {
            this.removeById(record.id); // идемпотентность
            const tokens = tokenize(record.text);
            const tf = new Map<string, number>();
            for (const t of tokens) {
                tf.set(t, (tf.get(t) ?? 0) + 1);
            }
            const doc: Doc = { record, length: tokens.length, tf };
            this.docs.set(record.id, doc);
            this.totalLength += doc.length;
            for (const term of tf.keys()) {
                let set = this.postings.get(term);
                if (!set) {
                    set = new Set();
                    this.postings.set(term, set);
                }
                set.add(record.id);
                this.df.set(term, (this.df.get(term) ?? 0) + 1);
            }
        }
    }

    private removeById(id: string): void {
        const doc = this.docs.get(id);
        if (!doc) {
            return;
        }
        this.totalLength -= doc.length;
        for (const term of doc.tf.keys()) {
            const set = this.postings.get(term);
            if (set) {
                set.delete(id);
                if (set.size === 0) {
                    this.postings.delete(term);
                }
            }
            const df = (this.df.get(term) ?? 1) - 1;
            if (df <= 0) {
                this.df.delete(term);
            } else {
                this.df.set(term, df);
            }
        }
        this.docs.delete(id);
    }

    removeByFile(filePath: string): void {
        const ids: string[] = [];
        for (const [id, doc] of this.docs) {
            if (doc.record.filePath === filePath) {
                ids.push(id);
            }
        }
        for (const id of ids) {
            this.removeById(id);
        }
    }

    clear(): void {
        this.docs.clear();
        this.postings.clear();
        this.df.clear();
        this.totalLength = 0;
    }

    search(query: string, k: number): VectorHit[] {
        const n = this.docs.size;
        if (n === 0) {
            return [];
        }
        const queryTerms = Array.from(new Set(tokenize(query)));
        if (queryTerms.length === 0) {
            return [];
        }
        const avgdl = this.totalLength / n || 1;
        const scores = new Map<string, number>();
        for (const term of queryTerms) {
            const set = this.postings.get(term);
            if (!set) {
                continue;
            }
            const df = this.df.get(term) ?? set.size;
            const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
            for (const id of set) {
                const doc = this.docs.get(id)!;
                const f = doc.tf.get(term) ?? 0;
                const denom = f + K1 * (1 - B + (B * doc.length) / avgdl);
                scores.set(id, (scores.get(id) ?? 0) + idf * ((f * (K1 + 1)) / (denom || 1)));
            }
        }
        const hits: VectorHit[] = [];
        for (const [id, score] of scores) {
            hits.push({ record: this.docs.get(id)!.record, score });
        }
        hits.sort((a, b) => b.score - a.score);
        return hits.slice(0, k);
    }
}
