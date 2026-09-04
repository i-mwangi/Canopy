'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { useAccount } from '@/components/account-provider';
import Image from 'next/image';

const STEPS = [
    {
        title: 'Dispatch',
        body: 'Pick a robot from the fleet. We reserve your estimated fare plus a buffer — nothing moves yet.',
    },
    {
        title: 'Meter',
        body: 'The robot reports runtime and completed tasks as it works. Watch the fare climb live.',
    },
    {
        title: 'Settle',
        body: 'When the job ends you are charged for exactly what you used. The rest of the hold is released.',
    },
];

export default function Landing() {
    const router = useRouter();
    const { session, signIn, loading } = useAccount();

    async function start(role: 'renter' | 'owner') {
        await signIn(role);
        router.push(role === 'renter' ? '/browse' : '/wallet');
    }

    return (
        <main className='px-14 py-16'>
            <header className='flex items-center gap-x-4'>
                <Image src='/images/logo.svg' alt='logo' width={66} height={54} className='h-auto' priority />
                <h4 className='text-secondary'>Canopy</h4>
            </header>

            <section className='mt-24 max-w-3xl'>
                <figure className='w-fit note'>
                    <Image src='/images/icons/power.svg' alt='power' width={8} height={8} />
                    <h6>Settled in USDC on Arc</h6>
                </figure>

                <h1 className='mt-6 text-6xl font-medium leading-[1.1]'>
                    Rent a warehouse robot
                    <br />
                    by the minute.
                </h1>

                <p className='mt-6 text-xl text-secondary'>
                    Fleet owners list their robots and set a rate. You dispatch one to a job, the meter
                    runs while it works, and you pay for what you used. No wallet to install, no keys to
                    manage, no gas to buy.
                </p>

                {session ? (
                    <div className='mt-10 flex items-center gap-x-4'>
                        <Link href='/browse' className='text-xl primary-button w-fit'>
                            Browse the fleet
                        </Link>
                        <Link href='/wallet' className='text-xl white-button w-fit'>
                            Wallet
                        </Link>
                    </div>
                ) : (
                    <div className='mt-10 flex items-center gap-x-4'>
                        <button
                            className='text-xl primary-button w-fit'
                            disabled={loading}
                            onClick={() => void start('renter')}
                        >
                            {loading ? <div className='spinner border-background' /> : 'Rent a robot'}
                        </button>
                        <button
                            className='text-xl white-button w-fit'
                            disabled={loading}
                            onClick={() => void start('owner')}
                        >
                            List my fleet
                        </button>
                    </div>
                )}
            </section>

            <section className='mt-28 grid grid-cols-1 md:grid-cols-3 gap-8'>
                {STEPS.map((step, index) => (
                    <article
                        key={step.title}
                        className='px-6 py-7 flex flex-col gap-y-3 border border-foreground rounded-lg card-shadow'
                    >
                        <h5 className='text-sm text-secondary'>0{index + 1}</h5>
                        <h3 className='text-2xl'>{step.title}</h3>
                        <p className='text-secondary'>{step.body}</p>
                    </article>
                ))}
            </section>

            <section className='mt-28 px-10 py-12 flex items-center justify-between gap-12 bg-gray-background rounded-lg'>
                <div className='max-w-xl'>
                    <h2 className='text-3xl'>Three classes on the floor</h2>
                    <p className='mt-4 text-secondary'>
                        Picking arms pull stock from the shelf, packing robots consolidate an order, and
                        delivery units carry it to the dock. Each class prices independently, and a class
                        that runs short surges until capacity frees up.
                    </p>
                </div>
                <div className='flex items-center gap-x-8'>
                    <Image src='/images/icons/crane.svg' alt='picking' width={64} height={74} className='h-auto' />
                    <Image src='/images/icons/robot.svg' alt='packing' width={64} height={64} className='h-auto' />
                    <Image
                        src='/images/icons/crane.svg'
                        alt='delivery'
                        width={64}
                        height={74}
                        className='h-auto scale-x-[-1]'
                    />
                </div>
            </section>
        </main>
    );
}
