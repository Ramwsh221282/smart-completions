export interface User {
    id: string;
    fullName: string;
    email: string;
}

export interface Order {
    id: string;
    userId: string;
    total: number;
}

export type Currency = 'USD' | 'EUR' | 'GBP';
