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

export default function Settlement({ rental, events, className }: Props) {
    const legs = [
        {
            title: 'Fare captured',
            party: 'From the renter balance',
            amount: rental.fare,
            event: events.find((entry) => entry.kind === 'fare_captured'),
        },
        {
            title: 'Robot owner paid',
            party: 'To the owner wallet',
            amount: rental.ownerPayout,
            event: events.find((entry) => entry.kind === 'payout_transferred'),
        },
        {
            title: 'Platform fee',
            party: 'To the revenue wallet',
            amount: rental.platformFee,
            event: events.find((entry) => entry.kind === 'fee_transferred'),
        },
    ];

    return (
        <section className={className}>
            <section className='mb-4 flex items-center gap-x-2.5'>
                <h4>Settlement</h4>
                <figure className='note'>
                    <Image src='/images/icons/power.svg' alt='power' height={8} width={8} />
                    <h6>Programmatic wallets, no keys handed to users</h6>
                </figure>
            </section>

            <section className='grid grid-cols-3 gap-x-3'>
                {legs.map((leg) => {
                    const done = leg.amount !== undefined;

                    return (
                        <figure
                            key={leg.title}
                            className='p-4 flex items-center justify-between gap-x-8 border border-secondary rounded-lg'
                        >
                            <section>
                                <div className='flex items-center gap-x-3.5'>
                                    <Image
                                        src='/images/icons/success.svg'
                                        alt='success'
                                        width={32}
                                        height={32}
                                        className={cn('h-auto', done ? 'opacity-100' : 'opacity-30')}
                                    />
                                    <div className='flex flex-col gap-y-1.5'>
                                        <h5 className='text-sm'>{leg.title}</h5>
                                        <h6 className='flex items-center gap-x-2 text-sm text-secondary'>
                                            {done ? (
                                                <span className='text-foreground font-medium tabular-nums'>
                                                    {usd(leg.amount)} USDC
                                                </span>
                                            ) : (
                                                <span className='text-secondary'>—</span>
                                            )}
                                        </h6>
                                    </div>
                                </div>

                                <div className='mt-5 flex items-center gap-x-2 text-xs font-light text-secondary'>
                                    {leg.event?.txHash ? (
                                        <h5>Tx: {shortAddress(leg.event.txHash)}</h5>
                                    ) : (
                                        <h5>{done ? leg.party : 'Not started'}</h5>
                                    )}
                                </div>
                            </section>

                            {leg.event?.txHash && EXPLORER && (
                                <a
                                    href={`${EXPLORER}/tx/${leg.event.txHash}`}
                                    target='_blank'
                                    rel='noreferrer'
                                >
                                    <Image
                                        src='/images/icons/redirect-button.svg'
                                        alt='link'
                                        width={24}
                                        height={40}
                                        className='h-auto'
                                    />
                                </a>
                            )}
                        </figure>
                    );
                })}
            </section>
        </section>
    );
}
