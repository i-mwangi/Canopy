'use client';

import { useEffect, useState } from 'react';

import { api, ApiError } from '@/lib/api';
import { cn, usd } from '@/lib/utils';
import { SurgePill } from '@/components/ui/status-pill';
import Image from 'next/image';
import type { Quote, Robot } from '@/lib/types';

interface Props {
    robot: Robot;
    accountId: string;
    onClose: () => void;
    onStarted: (rentalId: string) => void;
}

export default function RentModal({ robot, accountId, onClose, onStarted }: Props) {
    const [minutes, setMinutes] = useState(20);
    const [tasks, setTasks] = useState(4);
    const [quote, setQuote] = useState<Quote | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        let cancelled = false;

        // Re-quote as the estimate changes; surge can move between keystrokes.
        const timer = setTimeout(() => {
            api.quote(robot.id, minutes, tasks)
                .then((result) => {
                    if (!cancelled) {
                        setQuote(result);
                        setError(null);
                    }
                })
                .catch((cause: unknown) => {
                    if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not price this rental');
                });
        }, 250);

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [robot.id, minutes, tasks]);

    async function dispatch() {
        setSubmitting(true);
        setError(null);
        try {
            const rental = await api.startRental(robot.id, accountId, minutes, tasks);
            onStarted(rental.id);
        } catch (cause: unknown) {
            if (cause instanceof ApiError && cause.status === 402) {
                setError('Not enough available balance to cover the hold. Top up your wallet first.');
            } else {
                setError(cause instanceof Error ? cause.message : 'Could not start this rental');
            }
            setSubmitting(false);
        }
    }

    return (
        <div className='modal-background' onClick={onClose}>
            <section
                className='w-[32rem] px-8 py-9 flex flex-col gap-y-6 bg-background border border-foreground rounded-lg card-shadow'
                onClick={(event) => event.stopPropagation()}
            >
                <header className='flex items-center justify-between'>
                    <h2 className='text-2xl'>Dispatch Robot #{robot.id}</h2>
                    {quote && <SurgePill bps={quote.surgeBps} />}
                </header>

                <section className='grid grid-cols-2 gap-4'>
                    <label className='flex flex-col gap-y-1.5'>
                        <span className='text-sm text-secondary'>Estimated minutes</span>
                        <input
                            type='number'
                            min={1}
                            value={minutes}
                            onChange={(event) => setMinutes(Math.max(0, Number(event.target.value)))}
                        />
                    </label>
                    <label className='flex flex-col gap-y-1.5'>
                        <span className='text-sm text-secondary'>Estimated tasks</span>
                        <input
                            type='number'
                            min={0}
                            value={tasks}
                            onChange={(event) => setTasks(Math.max(0, Number(event.target.value)))}
                        />
                    </label>
                </section>

                <section className='flex flex-col gap-y-2.5 text-sm'>
                    <Row label='Base fare' value={usd(robot.rates.baseFare)} />
                    <Row
                        label={`Runtime · ${minutes} min`}
                        value={usd((Number(robot.rates.perMinute) * minutes).toFixed(6))}
                    />
                    <Row
                        label={`Tasks · ${tasks}`}
                        value={usd((Number(robot.rates.perTask) * tasks).toFixed(6))}
                    />
                    <Row label='Estimated fare' value={usd(quote?.estimatedFare)} strong />
                    <Row label='Authorization hold' value={usd(quote?.authorizationHold)} strong />
                </section>

                <figure className='note'>
                    <Image src='/images/icons/info.svg' alt='info' width={12} height={12} className='shrink-0' />
                    <h6>
                        The hold is a reservation, not a charge. You are billed for the metered fare when
                        the job ends and the remainder is released.
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
                        onClick={() => void dispatch()}
                    >
                        {submitting ? <div className='spinner border-background' /> : 'Dispatch'}
                    </button>
                </section>
            </section>
        </div>
    );
}

function Row({
    label,
    value,
    strong,
    muted,
}: {
    label: string;
    value: string;
    strong?: boolean;
    muted?: boolean;
}) {
    return (
        <div className={cn('flex items-center justify-between', muted && 'text-secondary')}>
            <span className={cn(!strong && 'text-secondary')}>{label}</span>
            <span className={cn(strong && 'font-medium')}>{value} USDC</span>
        </div>
    );
}
