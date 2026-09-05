'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import NavBar from '@/components/ui/nav-bar';
import RobotCard from '@/components/robot-card';
import OrderModal from '@/components/order-modal';
import { useAccount } from '@/components/account-provider';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { Robot, RobotClass } from '@/lib/types';

const CLASSES: (RobotClass | 'All')[] = ['All', 'Picking', 'Packing', 'Delivery'];

export default function Browse() {
    const router = useRouter();
    const { session } = useAccount();

    const [robots, setRobots] = useState<Robot[] | null>(null);
    const [filter, setFilter] = useState<RobotClass | 'All'>('All');
    const [ordering, setOrdering] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const load = () =>
            api
                .robots()
                .then((result) => {
                    setRobots(result);
                    setError(null);
                })
                .catch((cause: unknown) =>
                    setError(cause instanceof Error ? cause.message : 'Could not load the fleet'),
                );

        void load();

        // Availability drives surge, so the grid should not go stale while someone browses.
        const timer = setInterval(() => void load(), 10_000);
        return () => clearInterval(timer);
    }, []);

    const visible = robots?.filter((robot) => filter === 'All' || robot.class === filter) ?? null;

    return (
        <>
            <NavBar />
            <main className='px-14 pb-24'>
                <header className='flex items-end justify-between'>
                    <div>
                        <h1 className='text-4xl'>The fleet</h1>
                        <p className='mt-2 text-secondary'>
                            {robots
                                ? `${robots.filter((robot) => robot.status === 'Available').length} of ${robots.length} available now`
                                : 'Loading availability…'}
                        </p>
                    </div>

                    <div className='flex items-center gap-x-4'>
                    {session && (
                        <button className='primary-button !py-2.5' onClick={() => setOrdering(true)}>
                            Place an order
                        </button>
                    )}
                    <ul className='flex items-center gap-x-2'>
                        {CLASSES.map((option) => (
                            <li key={option}>
                                <button
                                    className={cn(
                                        'px-4 py-2 text-sm rounded-full cursor-pointer transition-colors',
                                        filter === option
                                            ? 'bg-foreground text-background'
                                            : 'bg-gray-background text-secondary hover:text-foreground',
                                    )}
                                    onClick={() => setFilter(option)}
                                >
                                    {option}
                                </button>
                            </li>
                        ))}
                    </ul>
                    </div>
                </header>

                {error && <p className='mt-10 text-red'>{error}</p>}

                <section className='mt-12 flex flex-wrap gap-x-10 gap-y-14'>
                    {visible === null
                        ? Array.from({ length: 4 }).map((_, index) => <SkeletonCard key={index} />)
                        : visible.map((robot) => (
                              <RobotCard key={robot.id} robot={robot} />
                          ))}
                </section>

                {visible?.length === 0 && (
                    <p className='mt-10 text-secondary'>No robots of this class are listed yet.</p>
                )}
            </main>

            {ordering && session && (
                <OrderModal
                    accountId={session.accountId}
                    onClose={() => setOrdering(false)}
                    onStarted={(rentalId) => router.push(`/rentals/${rentalId}`)}
                />
            )}
        </>
    );
}

function SkeletonCard() {
    return (
        <div className='w-72 h-[26rem] border border-tetriary rounded-lg bg-gray-background animate-pulse' />
    );
}
