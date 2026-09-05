export type RateCard = {
  /** Charged once when the meter starts. */
  baseFare: bigint;
  /** Charged per minute of robot runtime. */
  perMinute: bigint;
  /** Charged per completed task. */
  perTask: bigint;
  /** Floor applied after surge. */
  minimumFare: bigint;
};

/** What a fare is computed from. A half-finished leg is not a task and is not billed as one. */
export type BillableWork = {
  meteredMinutes: number;
  tasksCompleted: number;
};

export type MeterReading = BillableWork & {
  /** Individual moves finished: each leg is an approach followed by a carry. */
  movesCompleted: number;
};

export const MOVES_PER_TASK = 2;

export function tasksFromMoves(movesCompleted: number): number {
  return Math.floor(Math.max(0, movesCompleted) / MOVES_PER_TASK);
}

export type FareBreakdown = {
  baseFare: bigint;
  timeFare: bigint;
  taskFare: bigint;
  subtotal: bigint;
  surgeBps: number;
  surgeAmount: bigint;
  total: bigint;
  platformFee: bigint;
  ownerPayout: bigint;
};

export const BPS_DENOMINATOR = 10_000n;

/**
 * Fares are quoted and displayed in whole cents, so the split is quantised to cents too.
 * Leaving the fee at full USDC precision produces a fee and a payout that each round to a
 * different cent than the pair sums to, and a receipt whose column does not add up.
 */
export const CENT = 10_000n;

export type SurgeInputs = {
  availableRobots: number;
  totalRobots: number;
};

/**
 * Surge tracks fleet scarcity. Full availability prices at 1.0x and climbs as the pool
 * empties, capped so a nearly-empty fleet cannot produce a runaway quote.
 */
export function surgeBps(inputs: SurgeInputs, options: { maxBps?: number } = {}): number {
  const maxBps = options.maxBps ?? 25_000;
  if (inputs.totalRobots <= 0) return Number(BPS_DENOMINATOR);

  const available = Math.max(0, Math.min(inputs.availableRobots, inputs.totalRobots));
  const utilisation = 1 - available / inputs.totalRobots;

  if (utilisation <= 0.5) return Number(BPS_DENOMINATOR);

  const steepness = (utilisation - 0.5) / 0.5;
  const multiplier = 1 + steepness * steepness * 1.5;
  const computed = Math.round(Number(BPS_DENOMINATOR) * multiplier);

  return Math.min(computed, maxBps);
}

function applyBps(amount: bigint, bps: number): bigint {
  return (amount * BigInt(Math.round(bps))) / BPS_DENOMINATOR;
}

/** Rounds to the nearest cent, half away from zero. */
function toWholeCents(amount: bigint): bigint {
  return ((amount + CENT / 2n) / CENT) * CENT;
}

/**
 * Splits a fare between the platform and the robot owner. The fee is rounded to a whole cent
 * and the owner takes the remainder, so `platformFee + ownerPayout === fare` exactly at the
 * precision the fare is shown in.
 */
export function splitFare(fare: bigint, platformFeeBps: number): { platformFee: bigint; ownerPayout: bigint } {
  const exact = applyBps(fare, platformFeeBps);
  const rounded = toWholeCents(exact);
  const platformFee = rounded > fare ? fare : rounded;

  return { platformFee, ownerPayout: fare - platformFee };
}

/** Prices a meter reading against a rate card. */
export function quoteFare(params: {
  rates: RateCard;
  reading: BillableWork;
  surgeBps: number;
  platformFeeBps: number;
}): FareBreakdown {
  const minutes = BigInt(Math.max(0, Math.ceil(params.reading.meteredMinutes)));
  const tasks = BigInt(Math.max(0, Math.floor(params.reading.tasksCompleted)));

  const timeFare = params.rates.perMinute * minutes;
  const taskFare = params.rates.perTask * tasks;
  const subtotal = params.rates.baseFare + timeFare + taskFare;

  const surged = applyBps(subtotal, params.surgeBps);
  const total = surged > params.rates.minimumFare ? surged : params.rates.minimumFare;
  const { platformFee, ownerPayout } = splitFare(total, params.platformFeeBps);

  return {
    baseFare: params.rates.baseFare,
    timeFare,
    taskFare,
    subtotal,
    surgeBps: params.surgeBps,
    surgeAmount: surged - subtotal,
    total,
    platformFee,
    ownerPayout,
  };
}

/**
 * The amount to hold when a rental opens.
 *
 * Runtime is measured rather than estimated, so the hold cannot be sized from a guess at how
 * long the job will take. It covers the tasks the renter asked for plus the longest run the
 * marketplace is willing to bill, and the buffer absorbs a surge move between quote and start.
 */
export function authorizationAmount(params: {
  rates: RateCard;
  estimatedTasks: number;
  maxBillableMinutes: number;
  surgeBps: number;
  bufferBps: number;
}): bigint {
  const worstCase = quoteFare({
    rates: params.rates,
    reading: { meteredMinutes: params.maxBillableMinutes, tasksCompleted: params.estimatedTasks },
    surgeBps: params.surgeBps,
    platformFeeBps: 0,
  });

  return applyBps(worstCase.total, params.bufferBps);
}
