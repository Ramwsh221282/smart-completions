import { Currency } from './types';

export function computeTotalPrice(items: number[]): number {
    return items.reduce((sum, value) => sum + value, 0);
}

export function applyDiscount(total: number, percent: number): number {
    const factor = 1 - percent / 100;
    return total * factor;
}

export function formatPrice(amount: number, currency: Currency): string {
    return `${currency} ${amount.toFixed(2)}`;
}
