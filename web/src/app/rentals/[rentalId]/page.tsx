'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useMemo, useState } from 'react';

import NavBar from '@/components/ui/nav-bar';
import Floor from '@/components/ui/rental/floor';
import Logs from '@/components/ui/rental/logs';
import OrderLegs from '@/components/ui/rental/order-legs';
import Settlement from '@/components/ui/rental/settlement';
import { useAccount } from '@/components/account-provider';
import { api } from '@/lib/api';
import { cn, elapsedMinutes } from '@/lib/utils';
import type { Rental, RentalEvent } from '@/lib/types';

// The fleet drives itself through the route; a renter has no business stepping it forward.
// These stand in for a simulator that is not attached yet, so they are opt-in.
const SIMULATOR_CONTROLS = process.env.NEXT_PUBLIC_SIMULATOR_CONTROLS === 'true';

export default function RentalDetail({ params }: { params: Promise<{ rentalId: string }> }) {
    const { rentalId } = use(params);
    const { refresh } = useAccount();

    const [rental, setRental] = useState<Rental | null>(null);
    const [events, setEvents] = useState<RentalEvent[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [tick, setTick] = useState(Date.now());

    const load = useCallback(async () => {
        try {
            const [current, timeline] = await Promise.all([api.rental(rentalId), api.events(rentalId)]);
            setRental(current);
            setEvents(timeline);
            setError(null);
        } catch (cause: unknown) {
            setError(cause instanceof Error ? cause.message : 'Could not load this order');
        }
    }, [rentalId]);

    useEffect(() => {
        void load();
        const timer = setInterval(() => void load(), 4_000);
        return () => clearInterval(timer);
    }, [load]);

    useEffect(() => {
        const timer = setInterval(() => setTick(Date.now()), 1_000);
        return () => clearInterval(timer);
    }, []);

    async function cancel() {
        if (!rental) return;
        setBusy(true);
        try {
            await api.cancel(rental.id, 'cancelled by renter');
            await load();
            await refresh();
        } catch (cause: unknown) {
            setError(cause instanceof Error ? cause.message : 'Could not cancel this order');
        } finally {
            setBusy(false);
        }
    }

    /** Stands in for the fleet while no simulator is attached. */
    async function simulateMove() {
        if (!rental) return;
        setBusy(true);
        try {
            await api.meter(rental.id, rental.movesCompleted + 1);
            await load();
            await refresh();
        } catch (cause: unknown) {
            setError(cause instanceof Error ? cause.message : 'Could not report a move');
        } finally {
            setBusy(false);
        }
    }

    const runtimeMinutes = rental
        ? elapsedMinutes(rental.startedAt, rental.status === 'active' ? tick : (rental.endedAt ?? tick))
        : 0;

    /** What the order has cost so far, from the legs that have actually run. */
    const liveFare = useMemo(() => {
        if (!rental) return '0';
        if (rental.fare) return rental.fare;

        const now = rental.status === 'active' ? tick : (rental.endedAt ?? tick);
        const total = rental.legs.reduce((sum, leg) => {
            if (leg.startedAt === undefined) return sum;

            const minutes = Math.ceil(((leg.endedAt ?? now) - leg.startedAt) / 60_000);
            const base = Number(leg.rates.baseFare);
            const time = Number(leg.rates.perMinute) * minutes;
            const tasks = leg.movesCompleted >= 2 ? Number(leg.rates.perTask) : 0;
            const surged = (base + time + tasks) * (leg.surgeBps / 10_000);

            return sum + Math.max(surged, Number(leg.rates.minimumFare));
        }, 0);

        return Math.min(total, Number(rental.authorized)).toFixed(6);
    }, [rental, tick]);

    if (!rental) {
        return (
            <>
                <NavBar />
                <main className='px-14 pb-24'>
                    {error ? <p className='text-red'>{error}</p> : <p className='text-secondary'>Loading…</p>}
                </main>
            </>
        );
    }

    const running = rental.status === 'active';
    const activeLegIndex = Math.min(rental.legs.length - 1, Math.floor(rental.movesCompleted / 2));

    return (
        <>
            <NavBar />
            <main className='w-full flex items-center justify-center'>
                <div className='w-[90%] mb-16 flex flex-col items-center justify-center gap-y-12'>
                    <section className='w-full flex flex-col gap-y-10'>
                        <div className='flex items-center gap-x-6'>
                            <h1 className='text-4xl'>
                                #<span className='underline'>{rental.id.slice(0, 8).toUpperCase()}</span>
                            </h1>
                            <h5
                                className={cn(
                                    'p-3.5 rounded-sm capitalize',
                                    rental.status === 'settled'
                                        ? 'green-background'
                                        : rental.status === 'cancelled'
                                          ? 'red-background'
                                          : 'gray-background',
                                )}
                            >
                                {rental.status}
                            </h5>
                            <span className='gray-background text-xs'>
                                {rental.movesCompleted} of {rental.movesTotal} moves
                            </span>

                            <div className='ml-auto flex items-center gap-x-3'>
                                {running && (
                                    <>
                                        {SIMULATOR_CONTROLS && (
                                            <button
                                                className='white-button !py-2.5 !border-tetriary text-secondary'
                                                disabled={busy}
                                                onClick={() => void simulateMove()}
                                            >
                                                Simulate move {rental.movesCompleted + 1}
                                            </button>
                                        )}
                                        <button
                                            className='white-button !py-2.5'
                                            disabled={busy}
                                            onClick={() => void cancel()}
                                        >
                                            Cancel order
                                        </button>
                                    </>
                                )}
                                {!running && (
                                    <Link href='/browse' className='primary-button !py-2.5'>
                                        Place another order
                                    </Link>
                                )}
                            </div>
                        </div>

                        <OrderLegs rental={rental} activeLegIndex={activeLegIndex} />
                    </section>

                    <section className='w-full grid grid-cols-5 gap-x-9'>
                        <Logs events={events} className='col-span-2' />
                        <Floor
                            rental={rental}
                            runtimeMinutes={runtimeMinutes}
                            liveFare={liveFare}
                            className='col-span-3'
                        />
                    </section>

                    <Settlement rental={rental} events={events} className='w-full' />

                    {error && <p className='w-full text-red'>{error}</p>}
                </div>
            </main>
        </>
    );
}
