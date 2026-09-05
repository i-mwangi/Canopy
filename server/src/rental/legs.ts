import type { RobotClass } from '../fleet/registry.ts';

export type Zone = 'product-rack' | 'collecting-area' | 'packing-area' | 'delivery-area';

export type Move = {
  /** Arrow number on the warehouse floor plan. */
  step: number;
  label: string;
};

/**
 * What one task is, per robot class.
 *
 * A task is a whole leg of the fulfilment route rather than a free-form unit of work: the
 * simulator has one controller per class and each performs exactly this movement, so half a
 * leg is not something a robot can be asked to do.
 */
export type TaskLeg = {
  class_: RobotClass;
  /** Verb for one run of this leg. */
  name: string;
  from: Zone;
  to: Zone;
  /** The approach and the carry, in the order the floor plan numbers them. */
  moves: [Move, Move];
};

export const ZONE_LABELS: Record<Zone, string> = {
  'product-rack': 'Product Rack',
  'collecting-area': 'Collecting Area',
  'packing-area': 'Packing Area',
  'delivery-area': 'Delivery Area',
};

export const TASK_LEGS: Record<RobotClass, TaskLeg> = {
  0: {
    class_: 0,
    name: 'Pick',
    from: 'product-rack',
    to: 'collecting-area',
    moves: [
      { step: 1, label: 'Travel to the product rack' },
      { step: 2, label: 'Carry the item to the collecting area' },
    ],
  },
  1: {
    class_: 1,
    name: 'Pack',
    from: 'collecting-area',
    to: 'packing-area',
    moves: [
      { step: 3, label: 'Travel to the collecting area' },
      { step: 4, label: 'Carry the item to the packing area' },
    ],
  },
  2: {
    class_: 2,
    name: 'Deliver',
    from: 'packing-area',
    to: 'delivery-area',
    moves: [
      { step: 5, label: 'Travel to the packing area' },
      { step: 6, label: 'Carry the parcel to the delivery area' },
    ],
  },
};

export function legFor(class_: RobotClass): TaskLeg {
  const leg = TASK_LEGS[class_];
  if (!leg) throw new Error(`No task leg defined for robot class ${class_}`);
  return leg;
}

/** How the leg reads on a receipt: "Product Rack → Collecting Area". */
export function describeLeg(leg: TaskLeg): string {
  return `${ZONE_LABELS[leg.from]} → ${ZONE_LABELS[leg.to]}`;
}
