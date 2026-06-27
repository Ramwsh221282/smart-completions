import { injectable } from '@theia/core/shared/inversify';
import { LRUCache } from 'lru-cache';
import type { GenerationMode } from '../../common/model-types';
import type { FileMode } from '../../common/mode-types';

export interface FimCacheKeyInput {
    uri: string;
    fileMode: FileMode;
    generationMode: GenerationMode;
    prefix: string;
    suffix: string;
}

interface FimCacheEntry {
    prefix: string;
    suffix: string;
    fileMode: FileMode;
    generationMode: GenerationMode;
    completion: string;
}

const MAX_ENTRIES = 200;
const KEY_PREFIX_TAIL = 512;
const KEY_SUFFIX_HEAD = 256;

@injectable()
export class FimCompletionCache {
    private readonly exact = new LRUCache<string, FimCacheEntry>({ max: MAX_ENTRIES });
    // Prefix-extension reuse держится отдельно по uri: это ускоряет "допечатывание" без полного ключа на каждый keystroke.
    private readonly lastByUri = new Map<string, FimCacheEntry>();

    lookup(input: FimCacheKeyInput): string | null {
        const hit = this.exact.get(buildKey(input));
        if (hit !== undefined) {
            return hit.completion;
        }
        return this.lookupPrefixExtension(input);
    }

    store(input: FimCacheKeyInput, completion: string): void {
        if (completion.length === 0) {
            return;
        }
        const entry: FimCacheEntry = {
            prefix: input.prefix,
            suffix: input.suffix,
            fileMode: input.fileMode,
            generationMode: input.generationMode,
            completion,
        };
        this.exact.set(buildKey(input), entry);
        this.lastByUri.set(input.uri, entry);
    }

    clear(): void {
        this.exact.clear();
        this.lastByUri.clear();
    }

    private lookupPrefixExtension(input: FimCacheKeyInput): string | null {
        const last = this.lastByUri.get(input.uri);
        if (last === undefined) {
            return null;
        }
        if (last.suffix !== input.suffix || last.fileMode !== input.fileMode || last.generationMode !== input.generationMode) {
            return null;
        }
        if (!input.prefix.startsWith(last.prefix)) {
            return null;
        }
        const typed = input.prefix.slice(last.prefix.length);
        if (typed.length === 0 || !last.completion.startsWith(typed)) {
            return null;
        }
        const remaining = last.completion.slice(typed.length);
        return remaining.length > 0 ? remaining : null;
    }
}

function buildKey(input: FimCacheKeyInput): string {
    // Хэшируем только хвост/голову: они определяют локальный completion-context и не раздувают ключ полным документом.
    const prefixTail = input.prefix.length > KEY_PREFIX_TAIL ? input.prefix.slice(-KEY_PREFIX_TAIL) : input.prefix;
    const suffixHead = input.suffix.length > KEY_SUFFIX_HEAD ? input.suffix.slice(0, KEY_SUFFIX_HEAD) : input.suffix;
    return `${input.uri}\u0000${input.fileMode}\u0000${input.generationMode}\u0000${hash32(prefixTail)}\u0000${hash32(suffixHead)}`;
}

function hash32(text: string): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}
