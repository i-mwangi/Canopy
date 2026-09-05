'use client';

import Image from 'next/image';

import { cn, shortAddress, usd } from '@/lib/utils';
import type { Rental, RentalEvent } from '@/lib/types';

const EXPLORER = process.env.NEXT_PUBLIC_EXPLORER ?? '';

interface Props {
    rental: Rental;
    events: RentalEvent[];
    className?: string;
}

/**
 * Where the fare went.
 *
 * Three robots did the work and three owners are paid, so the split is one row per leg plus
 * the platform's share, rather than a single payout.
 */
export default function Settlement({ rental, events, className }: Props) {
    const payouts = events.filter((event) => event.kind === 'payout_transferred');
    const fee = events.find((event) => event.kind === 'fee_transferred');

    const rows = [
        ...rental.legs.map((leg, index) => ({
            title: `${leg.leg.name} owner`,
            subtitle: `Robot #${leg.robotId}`,
            amount: leg.ownerPayout,
            event: payouts[index],
        })),
        {
            title: 'Platform fee',
            subtitle: 'To the revenue wallet',
            amount: rental.platformFee,
            event: fee,
        },
    ];

    return (
        <section className={className}>
            <section className='mb-4 flex items-center gap-x-2.5'>
                <h4>Settlement</h4>
                <figure className='note'>
                    <Image src='/images/icons/power.svg' alt='power' height={8} width={8} />
                    <h6>Each owner paid for their own leg</h6>
                </figure>
                {rental.fare && (
                    <figure className='note'>
                        <h6>
                            Fare {usd(rental.fare)} USDC · authorised {usd(rental.authorized)}
                        </h6>
                    </figure>
                )}
            </section>

            <section className='grid grid-cols-4 gap-x-3'>
                {rows.map((row) => {
                    const done = row.amount !== undefined;

                    return (
                        <figure
                            key={row.title}
                            className='p-4 flex flex-col gap-y-4 border border-secondary rounded-lg'
                        >
                            <div className='flex items-center gap-x-3'>
                                <Image
                                    src='/images/icons/success.svg'
                                    alt='success'
                                    width={28}
                                    height={28}
                                    className={cn('h-auto', done ? 'opacity-100' : 'opacity-30')}
                                />
                                <div className='flex flex-col gap-y-1'>
                                    <h5 className='text-sm'>{row.title}</h5>
                                    <span
                                        className={cn(
                                            'text-sm tabular-nums',
                                            done ? 'text-foreground font-medium' : 'text-secondary',
                                        )}
                                    >
                                        {done ? `${usd(row.amount)} USDC` : '—'}
                                    </span>
                                </div>
                            </div>

                            <div className='text-xs font-light text-secondary'>
                                {row.event?.txHash ? (
                                    <a
                                        className='underline hover:text-foreground'
                                        href={`${EXPLORER}/tx/${row.event.txHash}`}
                                        target='_blank'
                                        rel='noreferrer'
                                    >
                                        Tx: {shortAddress(row.event.txHash)}
                                    </a>
                                ) : row.event?.transactionId ? (
                                    <span>Confirming on chain…</span>
                                ) : (
                                    <span>{done ? row.subtitle : 'Not started'}</span>
                                )}
                            </div>
                        </figure>
                    );
                })}
            </section>
        </section>
    );
}
