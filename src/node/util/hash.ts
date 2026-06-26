import { createHash } from 'crypto';

/** Детерминированный md5-хеш (для идемпотентных id чанков). */
export function md5(input: string): string {
    return createHash('md5').update(input).digest('hex');
}
