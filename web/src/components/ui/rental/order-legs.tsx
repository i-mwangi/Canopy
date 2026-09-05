'use client';

import Image from 'next/image';

import { cn, shortAddress, usd } from '@/lib/utils';
import type { Rental } from '@/lib/types';

interface Props {
    rental: Rental;
    activeLegIndex: number;
    className?: string;
}

/**
 * The three robots an order books, in the order they run.
 *
 * Each belongs to a different owner and is priced on its own rate card, so the split is shown
 * per leg rather than as a single figure.
 */
export default function OrderLegs({ rental, activeLegIndex, className }: Props) {
    return (
        <section className={cn('flex flex-col gap-y-4', className)}>
            <section className='flex items-center gap-x-2.5'>
                <h4>Order Route</h4>
                <figure className='note'>
                    <Image src='/images/icons/power.svg' alt='power' height={8} width={8} />
                    <h6>One robot per leg, each owner paid separately</h6>
                </figure>
            </section>

            <section className='grid grid-cols-3 gap-x-3'>
                {rental.legs.map((leg, index) => {
                    const done = leg.movesCompleted >= 2;
                    const active = rental.status === 'active' && index === activeLegIndex && !done;

                    return (
                        <figure
                            key={leg.class}
                            className={cn(
                                'p-4 flex flex-col gap-y-3 border rounded-lg transition-colors',
                                done || active ? 'border-foreground' : 'border-secondary',
                            )}
                        >
                            <div className='flex items-start justify-between gap-x-3'>
                                <div className='flex items-center gap-x-3'>
                                    <Image
                                        src='/images/icons/crane.svg'
                                        alt={leg.class}
                                        height={44}
                                        width={38}
                                        className={cn('h-auto', done || active ? 'opacity-100' : 'opacity-30')}
                                    />
                                    <div>
                                        <h5 className='text-sm'>{leg.leg.name}</h5>
                                        <h6 className='text-xs text-secondary'>Robot #{leg.robotId}</h6>
                                    </div>
                                </div>

                                <span
                                    className={cn(
                                        'text-xs',
                                        done ? 'green-background' : active ? 'amber-background' : 'gray-background',
                                    )}
                                >
                                    {done ? 'Done' : active ? 'Running' : 'Waiting'}
                                </span>
                            </div>

                            <h6 className='text-xs text-secondary'>{leg.leg.description}</h6>

                            <div className='flex items-center justify-between text-xs text-secondary'>
                                <span>{leg.movesCompleted} of 2 moves</span>
                                <span>{(leg.surgeBps / 10_000).toFixed(2)}x</span>
                            </div>

                            <div className='pt-2 border-t border-tetriary flex items-center justify-between text-sm'>
                                <span className='text-secondary'>Owner {shortAddress(leg.robotId)}</span>
                                <span className='font-medium tabular-nums'>
                                    {leg.ownerPayout ? `${usd(leg.ownerPayout)} USDC` : '—'}
                                </span>
                            </div>
                        </figure>
                    );
                })}
            </section>
        </section>
    );
}
