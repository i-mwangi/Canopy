'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import NavBar from '@/components/ui/nav-bar';
import { useAccount } from '@/components/account-provider';
import { RentalStatusPill } from '@/components/ui/status-pill';
import Image from 'next/image';
import { usd } from '@/lib/utils';
import type { Rental } from '@/lib/types';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

export default function Rentals() {
    const { session } = useAccount();
    const [rentals, setRentals] = useState<Rental[] | null>(null);

    useEffect(() => {
        if (!session) return;

        const load = () =>
            fetch(`${BASE}/accounts/${session.accountId}/rentals`, { cache: 'no-store' })
                .then((response) => (response.ok ? response.json() : []))
                .then(setRentals)
                .catch(() => setRentals([]));

        void load();
        const timer = setInterval(() => void load(), 6_000);
        return () => clearInterval(timer);
    }, [session]);

    if (!session) {
        return (
            <>
                <NavBar />
                <main className='px-14 pb-24'>
                    <p className='text-secondary'>Sign in from the home page to see your rentals.</p>
                </main>
            </>
        );
    }

    return (
        <>
            <NavBar />
            <main className='px-14 pb-24'>
                <h1 className='text-4xl'>Rentals</h1>
                <p className='mt-2 text-secondary'>Every job you have dispatched, and what it cost.</p>

                <ul className='mt-12 flex flex-col gap-y-2.5'>
                    {rentals === null && <li className='text-secondary'>Loading…</li>}
                    {rentals?.length === 0 && (
                        <li className='text-secondary'>
                            Nothing yet.{' '}
                            <Link href='/browse' className='underline text-foreground'>
                                Browse the fleet
                            </Link>{' '}
                            to dispatch a robot.
                        </li>
                    )}

                    {rentals?.map((rental) => (
                        <li key={rental.id}>
                            <Link
                                href={`/rentals/${rental.id}`}
                                className='px-6 py-5 flex items-center justify-between border border-secondary rounded-lg transition-colors hover:border-foreground'
                            >
                                <div className='flex items-center gap-x-5'>
                                    <div>
                                        <h3 className='text-xl'>
                                            Order #{rental.id.slice(0, 8).toUpperCase()}
                                        </h3>
                                        <h6 className='mt-1 text-xs text-secondary'>
                                            {new Date(rental.startedAt).toLocaleString()}
                                        </h6>
                                    </div>
                                    <RentalStatusPill status={rental.status} />
                                </div>

                                <div className='flex items-center gap-x-10 text-sm'>
                                    <Cell label='Robots' value={rental.legs.length.toString()} />
                                    <Cell
                                        label='Moves'
                                        value={`${rental.movesCompleted}/${rental.movesTotal}`}
                                    />
                                    <Cell
                                        label={rental.fare ? 'Charged' : 'Held'}
                                        value={`${usd(rental.fare ?? rental.authorized)} USDC`}
                                        strong
                                    />
                                    <Image src='/images/icons/side-arrow.svg' alt='open' width={12} height={12} className='h-auto' />
                                </div>
                            </Link>
                        </li>
                    ))}
                </ul>
            </main>
        </>
    );
}

function Cell({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
    return (
        <div className='text-right'>
            <h6 className='text-xs text-secondary'>{label}</h6>
            <span className={strong ? 'font-medium tabular-nums' : 'tabular-nums'}>{value}</span>
        </div>
    );
}
