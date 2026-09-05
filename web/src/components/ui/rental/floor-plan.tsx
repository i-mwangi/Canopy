import { cn } from '@/lib/utils';
import type { RobotClass } from '@/lib/types';

/**
 * The warehouse route, drawn rather than pictured.
 *
 * Each class owns one leg of two moves: an approach and a carry. Drawing it means the arrows
 * can light up as the robot works, instead of a static image implying a process the rental
 * is not actually performing.
 */

type Props = {
    /** Which leg this rental runs. Others are drawn faintly for context. */
    activeClass?: RobotClass;
    /** Moves finished so far, so the arrows fill in as work lands. */
    completedMoves?: number;
    running?: boolean;
    className?: string;
};

const LANES = [
    { class_: 'Picking' as const, x: 12, width: 196 },
    { class_: 'Packing' as const, x: 212, width: 196 },
    { class_: 'Delivery' as const, x: 412, width: 196 },
];

const ZONES = [
    { label: 'Product Rack', x: 22, y: 18, lane: 'Picking' },
    { label: 'Packing Area', x: 222, y: 18, lane: 'Packing' },
    { label: 'Collecting Area', x: 222, y: 300, lane: 'Packing' },
    { label: 'Delivery Area', x: 422, y: 300, lane: 'Delivery' },
];

/** Approach then carry, numbered as on the floor plan. */
const MOVES = [
    { step: 1, class_: 'Picking' as const, path: 'M105 210 C 100 150, 95 110, 100 62', badge: [64, 140] },
    { step: 2, class_: 'Picking' as const, path: 'M132 62 C 160 140, 200 250, 248 300', badge: [150, 250] },
    { step: 3, class_: 'Packing' as const, path: 'M300 210 C 290 250, 288 270, 292 298', badge: [262, 245] },
    { step: 4, class_: 'Packing' as const, path: 'M320 298 C 330 230, 322 130, 312 64', badge: [332, 150] },
    { step: 5, class_: 'Delivery' as const, path: 'M500 208 C 470 150, 420 90, 372 56', badge: [452, 130] },
    { step: 6, class_: 'Delivery' as const, path: 'M520 210 C 540 250, 535 280, 512 300', badge: [546, 250] },
];

const ROBOTS = [
    { class_: 'Picking' as const, x: 96, y: 214 },
    { class_: 'Packing' as const, x: 296, y: 214 },
    { class_: 'Delivery' as const, x: 496, y: 214 },
];

export default function FloorPlan({ activeClass, completedMoves = 0, running, className }: Props) {
    const isActive = (lane: string) => activeClass === undefined || lane === activeClass;

    // Moves belong to a leg, so "two done" means this leg's two arrows, not arrows one and two.
    const legMoves = MOVES.filter((move) => move.class_ === activeClass).map((move) => move.step);
    const doneSteps = new Set(legMoves.slice(0, completedMoves));

    return (
        <svg viewBox='0 0 620 400' className={cn('w-full h-auto', className)} role='img'>
            <title>Warehouse floor plan</title>

            <rect x='2' y='2' width='616' height='396' rx='6' fill='none' stroke='var(--foreground)' strokeWidth='2' />

            {LANES.slice(1).map((lane) => (
                <line
                    key={lane.class_}
                    x1={lane.x - 4}
                    y1='2'
                    x2={lane.x - 4}
                    y2='398'
                    stroke='var(--foreground)'
                    strokeWidth='1.5'
                />
            ))}

            {ZONES.map((zone) => (
                <g key={zone.label} opacity={isActive(zone.lane) ? 1 : 0.25}>
                    <rect
                        x={zone.x}
                        y={zone.y}
                        width='176'
                        height='46'
                        rx='4'
                        fill='none'
                        stroke='var(--tetriary)'
                        strokeWidth='2'
                        strokeDasharray='7 5'
                    />
                    <text
                        x={zone.x + 88}
                        y={zone.y + 29}
                        textAnchor='middle'
                        fontSize='15'
                        fill='var(--foreground)'
                    >
                        {zone.label}
                    </text>
                </g>
            ))}

            <defs>
                <marker id='arrow' viewBox='0 0 10 10' refX='9' refY='5' markerWidth='6' markerHeight='6' orient='auto'>
                    <path d='M0 0 L10 5 L0 10 z' fill='var(--foreground)' />
                </marker>
            </defs>

            {MOVES.map((move) => {
                const done = doneSteps.has(move.step);
                const dim = !isActive(move.class_);

                return (
                    <g key={move.step} opacity={dim ? 0.18 : 1}>
                        <path
                            d={move.path}
                            fill='none'
                            stroke='var(--foreground)'
                            strokeWidth={done ? 3.5 : 2}
                            markerEnd='url(#arrow)'
                            strokeDasharray={done || dim ? undefined : '6 6'}
                        />
                        <circle
                            cx={move.badge[0]}
                            cy={move.badge[1]}
                            r='13'
                            fill={done ? 'var(--green-background)' : 'var(--background)'}
                            stroke='var(--foreground)'
                            strokeWidth='1.5'
                        />
                        <text
                            x={move.badge[0]}
                            y={move.badge[1] + 5}
                            textAnchor='middle'
                            fontSize='13'
                            fill='var(--foreground)'
                        >
                            {move.step}
                        </text>
                    </g>
                );
            })}

            {ROBOTS.map((robot) => {
                const dim = !isActive(robot.class_);
                const working = running && robot.class_ === activeClass;

                return (
                    <g key={robot.class_} opacity={dim ? 0.18 : 1} transform={`translate(${robot.x} ${robot.y})`}>
                        <rect x='-14' y='0' width='28' height='14' rx='3' fill='var(--foreground)' />
                        <circle cx='-8' cy='17' r='4' fill='var(--foreground)' />
                        <circle cx='8' cy='17' r='4' fill='var(--foreground)' />
                        <path
                            d='M4 0 L4 -14 L16 -20'
                            fill='none'
                            stroke='var(--foreground)'
                            strokeWidth='3'
                            strokeLinecap='round'
                        />
                        {working && <circle cx='0' cy='-26' r='4' fill='var(--green)' className='animate-meter' />}
                    </g>
                );
            })}
        </svg>
    );
}
