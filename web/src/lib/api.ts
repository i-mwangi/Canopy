import type {
    Balance,
    Quote,
    Rental,
    RentalEvent,
    Robot,
    StatementEntry,
} from './types';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly detail: string,
    ) {
        super(detail);
        this.name = 'ApiError';
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${BASE}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
        cache: 'no-store',
    });

    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new ApiError(response.status, body.detail ?? body.error ?? response.statusText);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
}

export const api = {
    onboardRenter: () =>
        request<{ accountId: string; depositAddress: string }>('/accounts/renters', { method: 'POST' }),

    onboardOwner: () =>
        request<{ accountId: string; payoutAddress: string }>('/accounts/owners', { method: 'POST' }),

    balance: (accountId: string) => request<Balance>(`/accounts/${accountId}/balance`),

    syncDeposits: (accountId: string) =>
        request<{ credited: string; onChain: string }>(`/accounts/${accountId}/deposits/sync`, {
            method: 'POST',
        }),

    statement: (accountId: string) => request<StatementEntry[]>(`/accounts/${accountId}/statement`),

    withdraw: (accountId: string, amount: string, destinationAddress: string) =>
        request<{ transactionId: string; amount: string }>(`/accounts/${accountId}/withdrawals`, {
            method: 'POST',
            body: JSON.stringify({ amount, destinationAddress }),
        }),

    robots: () => request<Robot[]>('/robots'),

    quote: () => request<Quote>('/rentals/quote', { method: 'POST', body: '{}' }),

    startRental: (renterAccountId: string) =>
        request<Rental>('/rentals', { method: 'POST', body: JSON.stringify({ renterAccountId }) }),

    rental: (rentalId: string) => request<Rental>(`/rentals/${rentalId}`),

    events: (rentalId: string) => request<RentalEvent[]>(`/rentals/${rentalId}/events`),

    meter: (rentalId: string, movesCompleted: number) =>
        request<Rental>(`/rentals/${rentalId}/meter`, {
            method: 'POST',
            body: JSON.stringify({ movesCompleted }),
        }),

    complete: (rentalId: string, movesCompleted: number) =>
        request<Rental>(`/rentals/${rentalId}/complete`, {
            method: 'POST',
            body: JSON.stringify({ movesCompleted }),
        }),

    settle: (rentalId: string) => request<Rental>(`/rentals/${rentalId}/settle`, { method: 'POST' }),

    cancel: (rentalId: string, reason: string) =>
        request<Rental>(`/rentals/${rentalId}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),
};

export { ApiError };
