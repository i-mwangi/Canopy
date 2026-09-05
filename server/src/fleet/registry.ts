import { toMinorUnits } from '../config.ts';
import type { RateCard } from '../pricing/fare.ts';

/** Picking, Packing, Delivery — the three legs of the fulfilment route. */
export type RobotClass = 0 | 1 | 2;

export const ROBOT_STATUS = {
  unlisted: 0,
  available: 1,
  rented: 2,
  maintenance: 3,
} as const;

export type RobotStatus = (typeof ROBOT_STATUS)[keyof typeof ROBOT_STATUS];

export type Robot = {
  id: bigint;
  owner: `0x${string}`;
  class_: RobotClass;
  status: RobotStatus;
  rates: RateCard;
  metadataUri: string;
  completedRentals: number;
};

/**
 * Who owns which robot, what it charges, and whether it is free.
 *
 * This is the marketplace's own record. Reservation has to be atomic per robot: two orders
 * asking for the same class at the same moment must not both be handed the same unit.
 */
export interface FleetRegistry {
  list(): Promise<Robot[]>;
  get(robotId: bigint): Promise<Robot>;
  availability(class_: RobotClass): Promise<{ availableRobots: number; totalRobots: number }>;
  /** Claims a free robot of this class, or throws if the class is fully occupied. */
  reserve(class_: RobotClass): Promise<Robot>;
  /** Returns a robot to the pool. `completed` counts a finished order against it. */
  release(robotId: bigint, completed: boolean): Promise<void>;
}

export class RobotUnavailable extends Error {
  constructor(readonly class_: RobotClass) {
    super(`No robot of class ${class_} is available`);
    this.name = 'RobotUnavailable';
  }
}

const CLASS_RATES: Record<RobotClass, RateCard> = {
  0: {
    baseFare: toMinorUnits('2'),
    perMinute: toMinorUnits('0.35'),
    perTask: toMinorUnits('0.60'),
    minimumFare: toMinorUnits('3'),
  },
  1: {
    baseFare: toMinorUnits('1.5'),
    perMinute: toMinorUnits('0.25'),
    perTask: toMinorUnits('0.45'),
    minimumFare: toMinorUnits('2.5'),
  },
  2: {
    baseFare: toMinorUnits('3'),
    perMinute: toMinorUnits('0.5'),
    perTask: toMinorUnits('0.9'),
    minimumFare: toMinorUnits('4'),
  },
};

const DEFAULT_LAYOUT: { class_: RobotClass; count: number }[] = [
  { class_: 0, count: 4 },
  { class_: 1, count: 3 },
  { class_: 2, count: 3 },
];

/**
 * Reference registry. Robots live in memory, so a restart forgets them.
 *
 * Swapping in a database means implementing `FleetRegistry` with a row lock on reserve;
 * nothing above this interface changes.
 */
export class InMemoryFleetRegistry implements FleetRegistry {
  private readonly robots = new Map<string, Robot>();

  constructor(ownerAddress: `0x${string}`, layout = DEFAULT_LAYOUT) {
    let id = 0n;

    for (const { class_, count } of layout) {
      for (let index = 0; index < count; index += 1) {
        // One unit per class starts out down for maintenance, so the fleet is not uniform.
        // Never the only one: a class of a single robot would be permanently unrentable.
        const spare = count > 1 && index === count - 1 && class_ !== 1;
        const status: RobotStatus = spare ? ROBOT_STATUS.maintenance : ROBOT_STATUS.available;

        this.robots.set(id.toString(), {
          id,
          owner: ownerAddress,
          class_,
          status,
          rates: CLASS_RATES[class_],
          metadataUri: `canopy://robot/${id}`,
          completedRentals: 0,
        });
        id += 1n;
      }
    }
  }

  /** Gives a class its own owner, so an order pays three different people. */
  assignOwner(class_: RobotClass, owner: `0x${string}`): void {
    for (const robot of this.robots.values()) {
      if (robot.class_ === class_) robot.owner = owner;
    }
  }

  async list(): Promise<Robot[]> {
    return [...this.robots.values()].sort((a, b) => Number(a.id - b.id));
  }

  async get(robotId: bigint): Promise<Robot> {
    const robot = this.robots.get(robotId.toString());
    if (!robot) throw new Error(`Unknown robot ${robotId}`);
    return robot;
  }

  async availability(class_: RobotClass): Promise<{ availableRobots: number; totalRobots: number }> {
    const inClass = [...this.robots.values()].filter((robot) => robot.class_ === class_);

    return {
      availableRobots: inClass.filter((robot) => robot.status === ROBOT_STATUS.available).length,
      totalRobots: inClass.length,
    };
  }

  async reserve(class_: RobotClass): Promise<Robot> {
    for (const robot of this.robots.values()) {
      if (robot.class_ !== class_ || robot.status !== ROBOT_STATUS.available) continue;

      robot.status = ROBOT_STATUS.rented;
      return { ...robot };
    }

    throw new RobotUnavailable(class_);
  }

  async release(robotId: bigint, completed: boolean): Promise<void> {
    const robot = this.robots.get(robotId.toString());
    if (!robot || robot.status !== ROBOT_STATUS.rented) return;

    robot.status = ROBOT_STATUS.available;
    if (completed) robot.completedRentals += 1;
  }
}
