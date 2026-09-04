import { cn } from '@/lib/utils';
import type { RentalStatus, RobotStatus } from '@/lib/types';

const ROBOT_TONE: Record<RobotStatus, string> = {
    Available: 'green-background',
    Rented: 'amber-background',
    Maintenance: 'red-background',
    Unlisted: 'gray-background',
};

const RENTAL_TONE: Record<RentalStatus, string> = {
    active: 'amber-background',
    completed: 'gray-background',
    settled: 'green-background',
    cancelled: 'red-background',
};

export function RobotStatusPill({ status, className }: { status: RobotStatus; className?: string }) {
    return <span className={cn('text-xs', ROBOT_TONE[status], className)}>{status}</span>;
}

export function RentalStatusPill({ status, className }: { status: RentalStatus; className?: string }) {
    return <span className={cn('text-xs capitalize', RENTAL_TONE[status], className)}>{status}</span>;
}

export function SurgePill({ bps, className }: { bps: number; className?: string }) {
    const surging = bps > 10_000;
    return (
        <span className={cn('text-xs', surging ? 'red-background' : 'gray-background', className)}>
            {(bps / 10_000).toFixed(2)}x {surging ? 'surge' : 'standard'}
        </span>
    );
}
