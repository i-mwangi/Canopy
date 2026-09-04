'use client';

import Image from 'next/image';

import { RobotStatusPill } from '@/components/ui/status-pill';
import { cn, usd } from '@/lib/utils';
import type { Robot } from '@/lib/types';

/**
 * The fleet is one chassis doing three jobs, so every class uses the same unit art. Picking
 * shows the arm extended, packing shows it stowed at a station, and delivery mirrors the unit
 * so it reads as driving out.
 */
const CLASS_ART: Record<Robot['class'], { src: string; mirrored: boolean }> = {
    Picking: { src: '/images/icons/crane.svg', mirrored: false },
    Packing: { src: '/images/icons/robot.svg', mirrored: false },
    Delivery: { src: '/images/icons/crane.svg', mirrored: true },
};

interface Props {
    robot: Robot;
    onRent?: (robot: Robot) => void;
}

export default function RobotCard({ robot, onRent }: Props) {
    const art = CLASS_ART[robot.class];
    const rentable = robot.status === 'Available';

    return (
        <section className='flex flex-col text-center'>
            <section
                className={cn(
                    'min-w-fit w-72 px-6 py-7 flex flex-col gap-y-4 items-center border border-foreground rounded-lg',
                    !onRent && 'card-shadow',
                )}
            >
                <div className='w-full flex items-center justify-between'>
                    <h2 className='text-2xl'>Robot #{robot.id}</h2>
                    <RobotStatusPill status={robot.status} />
                </div>

                <Image
                    src={art.src}
                    alt={robot.class}
                    width={150}
                    height={150}
                    className={cn('h-auto', art.mirrored && 'scale-x-[-1]')}
                />

                <h5 className='text-sm text-secondary'>
                    {robot.class} · {robot.completedRentals} rentals
                </h5>

                <section className='w-full grid grid-cols-3 items-end justify-items-center text-secondary [&_h5]:text-xs'>
                    <div>
                        <h3 className='text-lg font-medium text-foreground'>{usd(robot.rates.baseFare)}</h3>
                        <h5>Base</h5>
                    </div>
                    <div>
                        <h3 className='text-lg font-medium text-foreground'>{usd(robot.rates.perMinute)}</h3>
                        <h5>Per min</h5>
                    </div>
                    <div>
                        <h3 className='text-lg font-medium text-foreground'>{usd(robot.rates.perTask)}</h3>
                        <h5>Per task</h5>
                    </div>
                </section>

                {onRent && (
                    <button
                        className='w-full text-xl primary-button'
                        disabled={!rentable}
                        onClick={() => onRent(robot)}
                    >
                        {rentable ? 'Rent' : robot.status}
                    </button>
                )}
            </section>

            <h6 className='mt-6 text-xs text-secondary'>Owner {robot.owner.slice(0, 6)}…{robot.owner.slice(-4)}</h6>
        </section>
    );
}
