'use client';

import Image from 'next/image';

import { cn, formatDuration, usd } from '@/lib/utils';
import type { Rental } from '@/lib/types';

interface Props {
    rental: Rental;
    runtimeMinutes: number;
    liveFare: string;
    className?: string;
}

export default function Floor({ rental, runtimeMinutes, liveFare, className }: Props) {
    const running = rental.status === 'active';

    return (
        <section className={className}>
            <section className='mb-4 flex items-center gap-x-2.5'>
                <h4>Warehouse Floor</h4>
                <figure className='note'>
                    <Image src='/images/icons/power.svg' alt='power' height={8} width={8} />
                    <h6>{running ? 'Robot working' : 'Idle'}</h6>
                </figure>
            </section>

            <section className='relative h-[400px] flex flex-col justify-between p-6 border border-secondary rounded-lg overflow-hidden'>
                <Image
                    src='/images/warehouse-design.svg'
                    alt='warehouse floor'
                    fill
                    className={cn(
                        'object-contain object-center transition-opacity',
                        running ? 'opacity-100' : 'opacity-40',
                    )}
                />

                <div className='relative z-10 flex items-start justify-between'>
                    <figure className='px-3 py-2 bg-background/90 border border-foreground rounded-lg'>
                        <h6 className='text-xs text-secondary'>Live fare</h6>
                        <h3 className='text-2xl font-medium tabular-nums'>{usd(liveFare)} USDC</h3>
                    </figure>

                    <figure className='px-3 py-2 bg-background/90 border border-secondary rounded-lg text-right'>
                        <h6 className='text-xs text-secondary'>Runtime billed</h6>
                        <h3 className='text-2xl font-medium tabular-nums'>{formatDuration(runtimeMinutes)}</h3>
                    </figure>
                </div>

                <div className='relative z-10 flex items-end justify-between gap-x-4'>
                    <figure className='px-3 py-2 flex items-center gap-x-3 bg-background/90 border border-secondary rounded-lg'>
                        <Image
                            src='/images/icons/robot.svg'
                            alt='robot'
                            height={28}
                            width={28}
                            className={cn('h-auto', running && 'animate-meter')}
                        />
                        <div>
                            <h6 className='text-xs text-secondary'>Robot #{rental.robotId}</h6>
                            <h5 className='text-sm'>
                                {rental.meter.tasksCompleted} task
                                {rental.meter.tasksCompleted === 1 ? '' : 's'} complete
                            </h5>
                        </div>
                    </figure>

                    <figure className='px-3 py-2 bg-background/90 border border-secondary rounded-lg text-right'>
                        <h6 className='text-xs text-secondary'>Billed at</h6>
                        <h5 className='text-sm tabular-nums'>
                            {Math.ceil(runtimeMinutes)} min · {rental.meter.tasksCompleted} tasks
                        </h5>
                    </figure>
                </div>
            </section>
        </section>
    );
}
