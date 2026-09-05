'use client';

import Image from 'next/image';
import { useState } from 'react';

import { cn, usd } from '@/lib/utils';
import type { RentalEvent } from '@/lib/types';

const EXPLORER = process.env.NEXT_PUBLIC_EXPLORER ?? '';

interface Props {
    events: RentalEvent[];
    className?: string;
}

function sliceHash(hash: string): string {
    return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
}

export default function Logs({ events, className }: Props) {
    const [copied, setCopied] = useState<number | null>(null);

    return (
        <section className={className}>
            <section className='mb-4 flex items-center gap-x-2.5'>
                <h4>Detail Log</h4>
                <figure className='note'>
                    <Image src='/images/icons/important.svg' alt='important' height={8} width={8} />
                    <h6>Every step of the rental, in order</h6>
                </figure>
            </section>

            <section className='flex flex-col gap-y-1.5 h-[400px] overflow-y-auto'>
                {events.length === 0 && (
                    <figure className='figure-row text-secondary text-sm'>Waiting for the first event…</figure>
                )}

                {events.map((event) => (
                    <figure key={event.id} className='figure-row'>
                        <section className='flex flex-col gap-y-3'>
                            <div className='flex items-center gap-x-2 flex-wrap'>
                                <Image
                                    src='/images/icons/success.svg'
                                    alt='done'
                                    height={16}
                                    width={16}
                                    className='h-auto'
                                />
                                <h5>{event.label}</h5>
                                {event.amount && (
                                    <span className='gray-background !px-2 !py-0.5 text-xs tabular-nums'>
                                        {usd(event.amount)} USDC
                                    </span>
                                )}
                            </div>
                            <div className='flex items-center gap-x-2 text-xs font-light text-secondary'>
                                {event.txHash ? (
                                    <>
                                        <h5>Tx: {sliceHash(event.txHash)}</h5>
                                        <button
                                            className='underline cursor-pointer'
                                            onClick={() => {
                                                void navigator.clipboard.writeText(event.txHash!);
                                                setCopied(event.id);
                                                setTimeout(() => setCopied(null), 1200);
                                            }}
                                        >
                                            {copied === event.id ? 'Copied' : 'Copy'}
                                        </button>
                                    </>
                                ) : event.transactionId ? (
                                    <h5>Confirming on chain…</h5>
                                ) : (
                                    <h5>{event.detail ?? '—'}</h5>
                                )}
                            </div>
                        </section>

                        {event.txHash && EXPLORER && (
                            <a
                                href={`${EXPLORER}/tx/${event.txHash}`}
                                target='_blank'
                                rel='noreferrer'
                                className={cn('shrink-0')}
                            >
                                <Image
                                    className='min-w-[24px] h-auto'
                                    src='/images/icons/redirect-button.svg'
                                    alt='link'
                                    width={24}
                                    height={40}
                                />
                            </a>
                        )}
                    </figure>
                ))}
            </section>
        </section>
    );
}
