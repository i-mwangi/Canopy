'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { api, ApiError } from '@/lib/api';
import type { Balance } from '@/lib/types';

type Session = {
    accountId: string;
    depositAddress: string;
    role: 'renter' | 'owner';
};

type AccountContextValue = {
    session: Session | null;
    balance: Balance | null;
    loading: boolean;
    signIn: (role: 'renter' | 'owner') => Promise<void>;
    signOut: () => void;
    refresh: () => Promise<void>;
};

const STORAGE_KEY = 'canopy-session';

const AccountContext = createContext<AccountContextValue | null>(null);

function readStoredSession(): Session | null {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        return raw ? (JSON.parse(raw) as Session) : null;
    } catch {
        return null;
    }
}

export function AccountProvider({ children }: { children: React.ReactNode }) {
    const [session, setSession] = useState<Session | null>(null);
    const [balance, setBalance] = useState<Balance | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        setSession(readStoredSession());
    }, []);

    const refresh = useCallback(async () => {
        if (!session) return;
        try {
            setBalance(await api.balance(session.accountId));
        } catch (cause: unknown) {
            // Accounts do not survive an API restart in stub mode, so a session pointing at one
            // that no longer exists is dropped rather than left to fail every request.
            if (cause instanceof ApiError && (cause.status === 404 || cause.status === 409)) {
                window.localStorage.removeItem(STORAGE_KEY);
                setSession(null);
            }
            setBalance(null);
        }
    }, [session]);

    useEffect(() => {
        void refresh();

        // The balance moves without the page doing anything: a deposit confirms, a rental
        // settles. Polling keeps the header honest.
        const timer = setInterval(() => void refresh(), 8_000);
        return () => clearInterval(timer);
    }, [refresh]);

    const signIn = useCallback(async (role: 'renter' | 'owner') => {
        setLoading(true);
        try {
            const created =
                role === 'renter'
                    ? await api.onboardRenter().then((result) => ({
                          accountId: result.accountId,
                          depositAddress: result.depositAddress,
                      }))
                    : await api.onboardOwner().then((result) => ({
                          accountId: result.accountId,
                          depositAddress: result.payoutAddress,
                      }));

            const next: Session = { ...created, role };
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
            setSession(next);
        } finally {
            setLoading(false);
        }
    }, []);

    const signOut = useCallback(() => {
        window.localStorage.removeItem(STORAGE_KEY);
        setSession(null);
        setBalance(null);
    }, []);

    const value = useMemo(
        () => ({ session, balance, loading, signIn, signOut, refresh }),
        [session, balance, loading, signIn, signOut, refresh],
    );

    return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountContextValue {
    const context = useContext(AccountContext);
    if (!context) throw new Error('useAccount must be used inside an AccountProvider');
    return context;
}
