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
    const [tasks, setTasks] = useState(1);
    const [quote, setQuote] = useState<Quote | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        let cancelled = false;

        // Re-quote as the estimate changes; surge can move between keystrokes.
        const timer = setTimeout(() => {
            api.quote(robot.id, tasks)
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
    }, [robot.id, tasks]);

    async function dispatch() {
        setSubmitting(true);
        setError(null);
        try {
            const rental = await api.startRental(robot.id, accountId, tasks);
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

                <section className='p-4 flex flex-col gap-y-3 bg-gray-background rounded-lg'>
                    <div className='flex items-center justify-between'>
                        <h5 className='font-medium'>One {robot.leg.name.toLowerCase()} task</h5>
                        <span className='text-xs text-secondary'>{robot.leg.description}</span>
                    </div>
                    <ol className='flex flex-col gap-y-1.5 text-xs text-secondary'>
                        {robot.leg.moves.map((move) => (
                            <li key={move.step} className='flex items-center gap-x-2'>
                                <span className='w-5 h-5 flex items-center justify-center rounded-full border border-secondary'>
                                    {move.step}
                                </span>
                                {move.label}
                            </li>
                        ))}
                    </ol>
                </section>

                <label className='flex flex-col gap-y-1.5'>
                    <span className='text-sm text-secondary'>
                        How many {robot.leg.name.toLowerCase()} tasks
                    </span>
                    <input
                        type='number'
                        min={1}
                        value={tasks}
                        onChange={(event) => setTasks(Math.max(1, Number(event.target.value)))}
                    />
                </label>

                <section className='flex flex-col gap-y-2.5 text-sm'>
                    <Row label='Base fare' value={usd(robot.rates.baseFare)} />
                    <Row
                        label={`${robot.leg.name} × ${tasks}`}
                        value={usd((Number(robot.rates.perTask) * tasks).toFixed(6))}
                    />
                    <Row label='Runtime' value={`${usd(robot.rates.perMinute)} per minute`} raw />
                    <hr className='my-1 border-tetriary' />
                    <Row label='Fare before runtime' value={usd(quote?.estimatedFare)} strong />
                    <Row label='Authorization hold' value={usd(quote?.authorizationHold)} strong />
                </section>

                <figure className='note'>
                    <Image src='/images/icons/info.svg' alt='info' width={12} height={12} className='shrink-0' />
                    <h6>
                        Runtime is measured while the robot works, not estimated up front, so the final
                        fare is only known when the job ends. The hold covers the tasks plus the longest
                        run we will bill
                        {quote ? ` (${quote.maxBillableMinutes} minutes)` : ''}; whatever is not used is
                        released.
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
    raw,
}: {
    label: string;
    value: string;
    strong?: boolean;
    raw?: boolean;
}) {
    return (
        <div className='flex items-center justify-between'>
            <span className={cn(!strong && 'text-secondary')}>{label}</span>
            <span className={cn(strong && 'font-medium')}>{raw ? value : `${value} USDC`}</span>
        </div>
    );
}
