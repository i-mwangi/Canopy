'use client';

import Image from 'next/image';
import Link from 'next/link';
import { use, useCallback, useEffect, useMemo, useState } from 'react';

import NavBar from '@/components/ui/nav-bar';
import Assignment from '@/components/ui/rental/assignment';
import Floor from '@/components/ui/rental/floor';
import Logs from '@/components/ui/rental/logs';
import Settlement from '@/components/ui/rental/settlement';
import { useAccount } from '@/components/account-provider';
import { SurgePill } from '@/components/ui/status-pill';
import { api } from '@/lib/api';
import { cn, elapsedMinutes, shortAddress, usd } from '@/lib/utils';
import type { Rental, RentalEvent, Robot } from '@/lib/types';

export default function RentalDetail({ params }: { params: Promise<{ rentalId: string }> }) {
    const { rentalId } = use(params);
    const { refresh } = useAccount();

    const [rental, setRental] = useState<Rental | null>(null);
    const [events, setEvents] = useState<RentalEvent[]>([]);
    const [robot, setRobot] = useState<Robot | null>(null);
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
            setError(cause instanceof Error ? cause.message : 'Could not load this rental');
        }
    }, [rentalId]);

    useEffect(() => {
        void load();
        const timer = setInterval(() => void load(), 4_000);
        return () => clearInterval(timer);
    }, [load]);

    useEffect(() => {
        // Local clock so the elapsed readout moves between polls.
        const timer = setInterval(() => setTick(Date.now()), 1_000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        if (!rental) return;
        api.robots()
            .then((fleet) => setRobot(fleet.find((entry) => entry.id === rental.robotId) ?? null))
            .catch(() => setRobot(null));
    }, [rental?.robotId]);

    async function act(action: 'complete' | 'settle' | 'cancel') {
        if (!rental) return;
        setBusy(true);
        try {
            if (action === 'complete') await api.complete(rental.id, rental.meter);
            if (action === 'settle') await api.settle(rental.id);
            if (action === 'cancel') await api.cancel(rental.id, 'cancelled by renter');
            await load();
            await refresh();
        } catch (cause: unknown) {
            setError(cause instanceof Error ? cause.message : 'That action failed');
        } finally {
            setBusy(false);
        }
    }

    /** Advances the meter by hand, standing in for the robot agent during a walkthrough. */
    async function advanceMeter() {
        if (!rental) return;
        setBusy(true);
        try {
            await api.meter(rental.id, {
                meteredMinutes: rental.meter.meteredMinutes + 2,
                tasksCompleted: rental.meter.tasksCompleted + 1,
            });
            await load();
        } catch (cause: unknown) {
            setError(cause instanceof Error ? cause.message : 'Could not push a meter reading');
        } finally {
            setBusy(false);
        }
    }

    const wallClock = rental
        ? rental.status === 'active'
            ? elapsedMinutes(rental.startedAt, tick)
            : rental.meter.meteredMinutes
        : 0;

    const liveFare = useMemo(() => {
        if (!rental) return '0';
        if (rental.fare) return rental.fare;
        if (!robot) return '0';

        const base = Number(robot.rates.baseFare);
        const time = Number(robot.rates.perMinute) * Math.ceil(rental.meter.meteredMinutes);
        const tasks = Number(robot.rates.perTask) * rental.meter.tasksCompleted;
        const surged = (base + time + tasks) * (rental.surgeBps / 10_000);

        return Math.min(surged, Number(rental.authorized)).toFixed(6);
    }, [rental, robot]);

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

    return (
        <>
            <NavBar />
            <main className='w-full flex items-center justify-center'>
                <div className='w-[90%] mb-16 flex flex-col items-center justify-center gap-y-12'>
                    <section className='w-full grid grid-cols-3 gap-x-6'>
                        <div className='mb-10 col-span-3 flex items-center gap-x-6'>
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
                            <SurgePill bps={rental.surgeBps} />

                            <div className='ml-auto flex items-center gap-x-3'>
                                {running && (
                                    <>
                                        <button
                                            className='white-button !py-2.5'
                                            disabled={busy}
                                            onClick={() => void advanceMeter()}
                                        >
                                            Advance meter
                                        </button>
                                        <button
                                            className='white-button !py-2.5'
                                            disabled={busy}
                                            onClick={() => void act('cancel')}
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            className='primary-button !py-2.5'
                                            disabled={busy}
                                            onClick={() => void act('complete')}
                                        >
                                            {busy ? <div className='spinner border-background' /> : 'End job'}
                                        </button>
                                    </>
                                )}
                                {rental.status === 'completed' && (
                                    <button
                                        className='primary-button !py-2.5'
                                        disabled={busy}
                                        onClick={() => void act('settle')}
                                    >
                                        {busy ? <div className='spinner border-background' /> : 'Settle fare'}
                                    </button>
                                )}
                                {(rental.status === 'settled' || rental.status === 'cancelled') && (
                                    <Link href='/browse' className='primary-button !py-2.5'>
                                        Rent another
                                    </Link>
                                )}
                            </div>
                        </div>

                        <figure className='relative h-fit self-end [&>*]:p-4 grid grid-cols-2 [&_h4]:text-secondary border border-secondary rounded-lg'>
                            <section className='border-r border-secondary'>
                                <h4 className='mb-4'>Robot</h4>
                                <Image
                                    src='/images/icons/crane.svg'
                                    alt='robot'
                                    height={32}
                                    width={28}
                                    className='h-auto'
                                />
                                <h5 className='mt-1 text-xs'>
                                    #{rental.robotId} · {robot?.class ?? '—'}
                                </h5>
                            </section>
                            <section className='[&>h5]:text-xs'>
                                <h4 className='mb-4'>Rate card</h4>
                                <h5>Base {usd(robot?.rates.baseFare)}</h5>
                                <h5>Per minute {usd(robot?.rates.perMinute)}</h5>
                                <h5>Per task {usd(robot?.rates.perTask)}</h5>
                            </section>
                            <section className='border-t border-secondary col-span-2'>
                                <h4 className='mb-4'>Owner</h4>
                                <h5 className='text-xs'>
                                    {robot ? shortAddress(robot.owner) : '—'}
                                </h5>
                            </section>
                        </figure>

                        <Assignment rental={rental} events={events} className='col-span-2 self-end' />
                    </section>

                    <section className='w-full grid grid-cols-5 gap-x-9'>
                        <Logs events={events} className='col-span-2' />
                        <Floor
                            rental={rental}
                            wallClock={wallClock}
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
