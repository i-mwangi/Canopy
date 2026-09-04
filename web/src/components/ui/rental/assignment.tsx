'use client';

import Image from 'next/image';

import { cn, usd } from '@/lib/utils';
import type { Rental, RentalEvent } from '@/lib/types';

interface Props {
    rental: Rental;
    events: RentalEvent[];
    className?: string;
}

const PHASES = [
    {
        key: 'authorize' as const,
        title: 'Authorization',
        caption: 'Funds reserved',
    },
    {
        key: 'work' as const,
        title: 'Robot Runtime',
        caption: 'Meter running',
    },
    {
        key: 'settle' as const,
        title: 'Settlement',
        caption: 'Fare captured and split',
    },
];

export default function Assignment({ rental, events, className }: Props) {
    return (
        <section className={cn('flex flex-col gap-y-4', className)}>
            <section className='flex items-center gap-x-2.5'>
                <h4>Rental Phases</h4>
                <figure className='note'>
                    <Image src='/images/icons/power.svg' alt='power' height={8} width={8} />
                    <h6>Metered billing</h6>
                </figure>
                <figure className='note'>
                    <Image src='/images/icons/important.svg' alt='important' height={8} width={8} />
                    <h6>Nothing moves until settlement</h6>
                </figure>
            </section>

            <section className='grid grid-cols-3 gap-x-2'>
                {PHASES.map((phase) => {
                    const phaseEvents = events.filter((event) => event.phase === phase.key);
                    const done =
                        phase.key === 'authorize'
                            ? phaseEvents.length >= 2
                            : phase.key === 'work'
                              ? rental.status !== 'active'
                              : rental.status === 'settled' || rental.status === 'cancelled';
                    const active = !done && isCurrent(phase.key, rental);

                    return (
                        <figure
                            key={phase.key}
                            className={cn(
                                'p-4 relative grid grid-cols-3 border rounded-lg transition-colors',
                                done ? 'border-foreground' : 'border-secondary',
                            )}
                        >
                            <Image
                                src='/images/icons/crane.svg'
                                alt='robot'
                                height={62}
                                width={54}
                                className={cn('h-auto', done ? 'opacity-100' : 'opacity-30')}
                            />

                            <div className='col-span-2'>
                                <h5 className='text-sm'>{phase.title}</h5>
                                <div className='mt-2.5 mb-2 text-xs text-secondary uppercase'>
                                    {phase.caption}
                                </div>
                                {active ? (
                                    <div className='spinner' />
                                ) : (
                                    <h5 className={cn('text-lg', !done && 'text-tetriary')}>
                                        {summary(phase.key, rental)}
                                    </h5>
                                )}
                            </div>

                            <div className='col-span-3 mt-3 flex items-center gap-x-2 text-xs font-light text-secondary'>
                                {phaseEvents.length > 0 ? (
                                    <h5>
                                        {phaseEvents.length} event
                                        {phaseEvents.length === 1 ? '' : 's'}
                                    </h5>
                                ) : (
                                    <h5>Pending…</h5>
                                )}
                            </div>
                        </figure>
                    );
                })}
            </section>
        </section>
    );
}

function isCurrent(phase: 'authorize' | 'work' | 'settle', rental: Rental): boolean {
    if (phase === 'work') return rental.status === 'active';
    if (phase === 'settle') return rental.status === 'completed';
    return false;
}

function summary(phase: 'authorize' | 'work' | 'settle', rental: Rental): string {
    if (phase === 'authorize') return `${usd(rental.authorized)} held`;
    if (phase === 'work') return `${Math.ceil(rental.meter.meteredMinutes)}m · ${rental.meter.tasksCompleted} tasks`;
    return rental.fare ? `${usd(rental.fare)} charged` : '—';
}
