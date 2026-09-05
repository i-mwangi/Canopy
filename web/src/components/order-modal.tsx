'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';

import { api, ApiError } from '@/lib/api';
import { cn, usd } from '@/lib/utils';
import type { Quote } from '@/lib/types';

interface Props {
    accountId: string;
    onClose: () => void;
    onStarted: (rentalId: string) => void;
}

/**
 * Placing an order, not renting a robot.
 *
 * One item travels the whole warehouse, so the marketplace picks a robot for each leg. There
 * is nothing to configure: the route is fixed and runtime is measured, so the only numbers
 * worth showing are what the legs cost and what is reserved.
 */
export default function OrderModal({ accountId, onClose, onStarted }: Props) {
    const [quote, setQuote] = useState<Quote | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        let cancelled = false;

        api.quote()
            .then((result) => {
                if (!cancelled) {
                    setQuote(result);
                    setError(null);
                }
            })
            .catch((cause: unknown) => {
                if (!cancelled) {
                    setError(cause instanceof Error ? cause.message : 'Could not price an order');
                }
            });

        return () => {
            cancelled = true;
        };
    }, []);

    async function place() {
        setSubmitting(true);
        setError(null);
        try {
            const rental = await api.startRental(accountId);
            onStarted(rental.id);
        } catch (cause: unknown) {
            if (cause instanceof ApiError && cause.status === 402) {
                setError('Not enough available balance to cover the hold. Top up your wallet first.');
            } else {
                setError(cause instanceof Error ? cause.message : 'Could not place this order');
            }
            setSubmitting(false);
        }
    }

    return (
        <div className='modal-background' onClick={onClose}>
            <section
                className='w-[34rem] max-h-[85dvh] overflow-y-auto px-8 py-9 flex flex-col gap-y-6 bg-background border border-foreground rounded-lg card-shadow'
                onClick={(event) => event.stopPropagation()}
            >
                <header>
                    <h2 className='text-2xl'>Place an order</h2>
                    <p className='mt-1 text-sm text-secondary'>
                        One item, picked, packed and delivered. A robot is reserved for each leg.
                    </p>
                </header>

                <section className='flex flex-col gap-y-2'>
                    {quote?.legs.map((leg, index) => (
                        <figure
                            key={leg.class}
                            className='p-3.5 flex items-center justify-between gap-x-4 border border-secondary rounded-lg'
                        >
                            <div className='flex items-center gap-x-3'>
                                <span className='w-6 h-6 flex items-center justify-center text-xs rounded-full border border-secondary'>
                                    {index + 1}
                                </span>
                                <div>
                                    <h5 className='text-sm'>
                                        {leg.leg.name} · Robot #{leg.robotId}
                                    </h5>
                                    <h6 className='text-xs text-secondary'>{leg.leg.description}</h6>
                                </div>
                            </div>
                            <div className='text-right text-xs text-secondary'>
                                <div>{usd(leg.rates.baseFare)} base</div>
                                <div>{usd(leg.rates.perMinute)} per min</div>
                            </div>
                        </figure>
                    ))}

                    {!quote && <p className='text-sm text-secondary'>Finding an available robot per leg…</p>}
                </section>

                {quote && (
                    <section className='flex flex-col gap-y-2.5 text-sm'>
                        <Row label='Fare before runtime' value={usd(quote.fareFloor)} strong />
                        <Row label='Authorization hold' value={usd(quote.authorizationHold)} strong />
                    </section>
                )}

                <figure className='note'>
                    <Image src='/images/icons/info.svg' alt='info' width={12} height={12} className='shrink-0' />
                    <h6>
                        Each robot is billed for its own stretch of the route, measured while it works. The
                        hold covers all three legs running their full allowance
                        {quote ? ` (${quote.maxBillableMinutes} minutes each)` : ''}; whatever is not used
                        is released when the order finishes.
                    </h6>
                </figure>

                {error && <p className='text-sm text-red'>{error}</p>}

                <section className='flex items-center gap-x-3'>
                    <button className='flex-1 white-button' onClick={onClose}>
                        Cancel
                    </button>
                    <button
                        className='flex-1 primary-button'
                        disabled={submitting || !quote}
                        onClick={() => void place()}
                    >
                        {submitting ? <div className='spinner border-background' /> : 'Place order'}
                    </button>
                </section>
            </section>
        </div>
    );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
    return (
        <div className='flex items-center justify-between'>
            <span className={cn(!strong && 'text-secondary')}>{label}</span>
            <span className={cn(strong && 'font-medium')}>{value} USDC</span>
        </div>
    );
}
