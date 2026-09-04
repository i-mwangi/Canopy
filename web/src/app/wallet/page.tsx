'use client';

import { useEffect, useState } from 'react';

import NavBar from '@/components/ui/nav-bar';
import { useAccount } from '@/components/account-provider';
import Image from 'next/image';
import { api, ApiError } from '@/lib/api';
import { cn, usd } from '@/lib/utils';
import type { StatementEntry } from '@/lib/types';

const KIND_LABELS: Record<string, string> = {
    deposit: 'Deposit',
    hold: 'Authorization held',
    hold_release: 'Authorization released',
    capture: 'Fare charged',
    payout: 'Rental earnings',
    platform_fee: 'Platform fee',
    withdrawal: 'Withdrawal',
    sweep: 'Swept to treasury',
    topup: 'Operating top-up',
    adjustment: 'Adjustment',
};

export default function Wallet() {
    const { session, balance, refresh } = useAccount();

    const [entries, setEntries] = useState<StatementEntry[]>([]);
    const [amount, setAmount] = useState('');
    const [destination, setDestination] = useState('');
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);
    const [checking, setChecking] = useState(false);

    useEffect(() => {
        if (!session) return;

        const load = () =>
            api
                .statement(session.accountId)
                .then(setEntries)
                .catch(() => setEntries([]));

        void load();
        const timer = setInterval(() => void load(), 8_000);
        return () => clearInterval(timer);
    }, [session]);

    if (!session) {
        return (
            <>
                <NavBar />
                <main className='px-14 pb-24'>
                    <p className='text-secondary'>Sign in from the home page to open a wallet.</p>
                </main>
            </>
        );
    }

    async function withdraw() {
        if (!session) return;
        setBusy(true);
        setError(null);
        setMessage(null);
        try {
            const result = await api.withdraw(session.accountId, amount, destination);
            setMessage(`Withdrawal of ${usd(result.amount)} USDC submitted.`);
            setAmount('');
            setDestination('');
            await refresh();
        } catch (cause: unknown) {
            if (cause instanceof ApiError && cause.status === 402) {
                setError('That is more than your available balance. Held funds cannot be withdrawn.');
            } else {
                setError(cause instanceof Error ? cause.message : 'Withdrawal failed');
            }
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <NavBar />
            <main className='px-14 pb-24'>
                <h1 className='text-4xl'>Wallet</h1>
                <p className='mt-2 text-secondary capitalize'>{session.role} account</p>

                <section className='mt-12 grid grid-cols-1 lg:grid-cols-3 gap-8'>
                    <article className='px-8 py-9 border border-foreground rounded-lg card-shadow'>
                        <h5 className='text-sm text-secondary'>Available</h5>
                        <h2 className='mt-2 text-4xl font-medium tabular-nums'>
                            {usd(balance?.available)}
                        </h2>
                        <h6 className='mt-1 text-xs text-secondary'>USDC, spendable now</h6>
                    </article>
                    <article className='px-8 py-9 border border-secondary rounded-lg'>
                        <h5 className='text-sm text-secondary'>Held</h5>
                        <h2 className='mt-2 text-4xl font-medium tabular-nums'>{usd(balance?.held)}</h2>
                        <h6 className='mt-1 text-xs text-secondary'>Reserved by open rentals</h6>
                    </article>
                    <article className='px-8 py-9 border border-secondary rounded-lg'>
                        <h5 className='text-sm text-secondary'>Total</h5>
                        <h2 className='mt-2 text-4xl font-medium tabular-nums'>{usd(balance?.total)}</h2>
                        <h6 className='mt-1 text-xs text-secondary'>Available plus held</h6>
                    </article>
                </section>

                <section className='mt-12 grid grid-cols-1 lg:grid-cols-2 gap-10'>
                    <article className='px-8 py-9 flex flex-col gap-y-5 border border-secondary rounded-lg'>
                        <div className='flex items-center gap-x-2.5'>
                            <Image src='/images/icons/energy.svg' alt='funds' width={24} height={24} className='h-auto' />
                            <h4>Add funds</h4>
                        </div>

                        <p className='text-sm text-secondary'>
                            Send USDC on Arc to this address, then check for it. Deposits normally arrive
                            through a Circle notification; this asks the chain directly, which is what a
                            local environment with no public URL needs.
                        </p>

                        <button
                            className='primary-button'
                            disabled={checking}
                            onClick={() => {
                                if (!session) return;
                                setChecking(true);
                                setMessage(null);
                                setError(null);
                                api.syncDeposits(session.accountId)
                                    .then(async (result) => {
                                        setMessage(
                                            Number(result.credited) > 0
                                                ? `Credited ${usd(result.credited)} USDC.`
                                                : 'No new deposits found.',
                                        );
                                        await refresh();
                                    })
                                    .catch((cause: unknown) =>
                                        setError(cause instanceof Error ? cause.message : 'Could not check'),
                                    )
                                    .finally(() => setChecking(false));
                            }}
                        >
                            {checking ? <div className='spinner border-background' /> : 'Check for deposits'}
                        </button>

                        <div
                            className='p-3.5 flex items-center justify-between gap-x-3 bg-gray-background rounded-lg cursor-pointer'
                            onClick={() => {
                                void navigator.clipboard.writeText(session.depositAddress);
                                setCopied(true);
                                setTimeout(() => setCopied(false), 1500);
                            }}
                        >
                            <code className='text-xs break-all'>{session.depositAddress}</code>
                            <span className='text-xs text-secondary shrink-0'>
                                {copied ? 'Copied' : 'Copy'}
                            </span>
                        </div>
                    </article>

                    <article className='px-8 py-9 flex flex-col gap-y-5 border border-secondary rounded-lg'>
                        <h4>Withdraw</h4>

                        <label className='flex flex-col gap-y-1.5'>
                            <span className='text-sm text-secondary'>Amount (USDC)</span>
                            <input
                                inputMode='decimal'
                                placeholder='0.00'
                                value={amount}
                                onChange={(event) => setAmount(event.target.value)}
                            />
                        </label>

                        <label className='flex flex-col gap-y-1.5'>
                            <span className='text-sm text-secondary'>Destination address</span>
                            <input
                                placeholder='0x…'
                                value={destination}
                                onChange={(event) => setDestination(event.target.value)}
                            />
                        </label>

                        <figure className='note'>
                            <Image src='/images/icons/info.svg' alt='info' width={12} height={12} className='shrink-0' />
                            <h6>Only your available balance can be withdrawn. Held funds stay put.</h6>
                        </figure>

                        {message && <p className='text-sm text-green'>{message}</p>}
                        {error && <p className='text-sm text-red'>{error}</p>}

                        <button
                            className='primary-button'
                            disabled={busy || !amount || !destination}
                            onClick={() => void withdraw()}
                        >
                            {busy ? <div className='spinner border-background' /> : 'Withdraw'}
                        </button>
                    </article>
                </section>

                <section className='mt-16'>
                    <h4>Activity</h4>
                    <ul className='mt-6 flex flex-col gap-y-1.5'>
                        {entries.length === 0 && (
                            <li className='text-secondary text-sm'>Nothing has moved yet.</li>
                        )}
                        {[...entries].reverse().map((entry) => {
                            const value = Number.parseFloat(entry.amount);
                            const held = Number.parseFloat(entry.heldDelta);

                            return (
                                <li key={entry.id} className='figure-row'>
                                    <div className='flex flex-col gap-y-1'>
                                        <span>{KIND_LABELS[entry.kind] ?? entry.kind}</span>
                                        <span className='text-xs text-secondary'>
                                            {entry.memo ?? '—'} ·{' '}
                                            {new Date(entry.createdAt).toLocaleString()}
                                        </span>
                                    </div>
                                    <span
                                        className={cn(
                                            'tabular-nums',
                                            value > 0 && 'text-green',
                                            value < 0 && 'text-red',
                                            value === 0 && 'text-secondary',
                                        )}
                                    >
                                        {value === 0
                                            ? `${held > 0 ? '−' : '+'}${usd(Math.abs(held).toFixed(6))} held`
                                            : `${value > 0 ? '+' : '−'}${usd(Math.abs(value).toFixed(6))}`}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                </section>
            </main>
        </>
    );
}
