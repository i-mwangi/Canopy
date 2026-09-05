'use client';

import Image from 'next/image';

import FloorPlan from '@/components/ui/rental/floor-plan';
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

    // Arrows show progress through the leg being run now. A finished leg leaves both filled,
    // and the next approach starts the pair again.
    const { movesCompleted } = rental.meter;
    const movesInCurrentLeg = movesCompleted === 0 ? 0 : movesCompleted % 2 === 0 ? 2 : 1;

    return (
        <section className={className}>
            <section className='mb-4 flex items-center gap-x-2.5'>
                <h4>Warehouse Floor</h4>
                <figure className='note'>
                    <Image src='/images/icons/power.svg' alt='power' height={8} width={8} />
                    <h6>{running ? 'Robot working' : 'Idle'}</h6>
                </figure>
            </section>

            <section className='px-6 py-6 flex flex-col gap-y-5 border border-secondary rounded-lg'>
                <div className='flex items-start justify-between gap-x-4'>
                    <figure className='px-3 py-2 border border-foreground rounded-lg'>
                        <h6 className='text-xs text-secondary'>Live fare</h6>
                        <h3 className='text-2xl font-medium tabular-nums'>{usd(liveFare)} USDC</h3>
                    </figure>

                    <figure className='px-3 py-2 border border-secondary rounded-lg text-right'>
                        <h6 className='text-xs text-secondary'>Runtime billed</h6>
                        <h3 className='text-2xl font-medium tabular-nums'>
                            {formatDuration(runtimeMinutes)}
                        </h3>
                    </figure>
                </div>

                <FloorPlan
                    activeClass={rental.class}
                    completedMoves={movesInCurrentLeg}
                    running={running}
                />

                <div className='flex items-center justify-between gap-x-4 text-sm'>
                    <div className='flex items-center gap-x-3'>
                        <Image
                            src='/images/icons/robot.svg'
                            alt='robot'
                            height={24}
                            width={24}
                            className={cn('h-auto', running && 'animate-meter')}
                        />
                        <div>
                            <h6 className='text-xs text-secondary'>Robot #{rental.robotId}</h6>
                            <h5>{rental.leg.description}</h5>
                        </div>
                    </div>
                    <h5 className='tabular-nums'>
                        {rental.meter.tasksCompleted} × {rental.leg.name} · {movesCompleted} moves ·{' '}
                        {Math.ceil(runtimeMinutes)} min billed
                    </h5>
                </div>
            </section>
        </section>
    );
}
