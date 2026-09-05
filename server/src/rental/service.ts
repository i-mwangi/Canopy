import { randomUUID } from 'node:crypto';

import type { AppConfig } from '../config.ts';
import type { CircleWalletGateway } from '../circle/client.ts';
import type { Ledger } from '../ledger/ledger.ts';
import { LedgerConflict } from '../ledger/types.ts';
import {
  orderAuthorization,
  quoteFare,
  settleOrder,
  surgeBps,
  MOVES_PER_TASK,
  type RateCard,
} from '../pricing/fare.ts';
import type { FleetRegistry, RobotClass } from '../fleet/registry.ts';
import type { RentalEventLog } from './events.ts';
import { describeLeg, legFor } from './legs.ts';

export type RentalStatus = 'active' | 'completed' | 'settled' | 'cancelled';

/** The three legs of an order, in the order they are run. */
export const ORDER_CLASSES: RobotClass[] = [0, 1, 2];

export const MOVES_PER_ORDER = ORDER_CLASSES.length * MOVES_PER_TASK;

/**
 * One leg of an order: a robot, its owner, and what it is owed.
 *
 * Each leg is priced on its own robot's rate card and paid to its own owner, because the
 * three robots in an order can belong to three different people.
 */
export type RentalLeg = {
  class_: RobotClass;
  robotId: bigint;
  ownerAccountId: string;
  ownerAddress: `0x${string}`;
  rates: RateCard;
  surgeBps: number;
  /** Set when the previous leg hands over, so each robot is billed only for its own stretch. */
  startedAt?: number;
  endedAt?: number;
  movesCompleted: number;
  fare?: bigint;
  platformFee?: bigint;
  ownerPayout?: bigint;
};

export type Rental = {
  id: string;
  renterAccountId: string;
  status: RentalStatus;
  holdId: string;
  authorizedAmount: bigint;
  legs: RentalLeg[];
  /** Moves finished across the whole order, from 0 to six. */
  movesCompleted: number;
  startedAt: number;
  endedAt?: number;
  fare?: bigint;
  platformFee?: bigint;
  settlementRef?: string;
};

export interface RentalStore {
  put(rental: Rental): Promise<void>;
  get(rentalId: string): Promise<Rental | undefined>;
  listByRenter(accountId: string): Promise<Rental[]>;
}

export class InMemoryRentalStore implements RentalStore {
  private readonly rentals = new Map<string, Rental>();

  async put(rental: Rental): Promise<void> {
    this.rentals.set(rental.id, rental);
  }

  async get(rentalId: string): Promise<Rental | undefined> {
    return this.rentals.get(rentalId);
  }

  async listByRenter(accountId: string): Promise<Rental[]> {
    return [...this.rentals.values()].filter((rental) => rental.renterAccountId === accountId);
  }
}

/** Maps on-chain identities back to the ledger accounts that hold their balance. */
export interface AccountDirectory {
  ownerAccountIdFor(address: `0x${string}`): Promise<string | undefined>;
  registerOwner(address: `0x${string}`, accountId: string): Promise<void>;
}

export class InMemoryAccountDirectory implements AccountDirectory {
  private readonly owners = new Map<string, string>();

  async ownerAccountIdFor(address: `0x${string}`): Promise<string | undefined> {
    return this.owners.get(address.toLowerCase());
  }

  async registerOwner(address: `0x${string}`, accountId: string): Promise<void> {
    this.owners.set(address.toLowerCase(), accountId);
  }
}

export type PlatformAccounts = {
  treasuryAccountId: string;
  operatingAccountId: string;
  revenueAccountId: string;
};

export class RentalService {
  constructor(
    private readonly config: AppConfig,
    private readonly ledger: Ledger,
    private readonly rentals: RentalStore,
    private readonly fleet: FleetRegistry,
    private readonly wallets: CircleWalletGateway,
    private readonly platform: PlatformAccounts,
    private readonly directory: AccountDirectory,
    private readonly events: RentalEventLog,
  ) {}

  /**
   * Prices an order without reserving anything.
   *
   * An order is one item moved the whole way through the warehouse, so it needs one robot of
   * each class. Runtime is measured while they work, so nothing here estimates a duration:
   * the figure shown is the floor, and the hold covers the ceiling.
   */
  async quote() {
    const { maxBillableMinutes, platformFeeBps, authorizationBufferBps } = this.config.marketplace;
    const candidates = await this.candidateRobots();

    const legs = candidates.map((robot) => ({ rates: robot.rates, surgeBps: robot.surgeBps }));

    const floor = candidates.reduce(
      (sum, robot) =>
        sum +
        quoteFare({
          rates: robot.rates,
          reading: { meteredMinutes: 0, tasksCompleted: 1 },
          surgeBps: robot.surgeBps,
          platformFeeBps: 0,
        }).total,
      0n,
    );

    const authorization = orderAuthorization({
      legs,
      maxBillableMinutes,
      bufferBps: authorizationBufferBps,
    });

    return {
      legs: candidates.map((robot) => ({
        class_: robot.class_,
        robotId: robot.robotId,
        rates: robot.rates,
        surgeBps: robot.surgeBps,
      })),
      fareFloor: floor,
      authorization,
      maxBillableMinutes,
      platformFeeBps,
    };
  }

  /**
   * Opens an order: reserves one robot per class and holds the worst-case fare.
   *
   * The hold is a ledger entry, so no funds move until the last robot finishes.
   */
  async startRental(params: { renterAccountId: string }): Promise<Rental> {
    const renter = await this.ledger.requireAccount(params.renterAccountId);
    if (renter.role !== 'renter') throw new LedgerConflict(`Account ${renter.id} is not a renter account`);

    const candidates = await this.candidateRobots();
    const authorization = orderAuthorization({
      legs: candidates.map((robot) => ({ rates: robot.rates, surgeBps: robot.surgeBps })),
      maxBillableMinutes: this.config.marketplace.maxBillableMinutes,
      bufferBps: this.config.marketplace.authorizationBufferBps,
    });

    const rentalId = randomUUID();
    const hold = await this.ledger.placeHold({
      accountId: renter.id,
      rentalId,
      amount: authorization,
      groupId: `hold:${rentalId}`,
    });

    const legs: RentalLeg[] = [];
    try {
      for (const candidate of candidates) {
        const robot = await this.fleet.reserve(candidate.class_);
        const ownerAccount = await this.resolveOwnerAccount(robot.owner);

        legs.push({
          class_: robot.class_,
          robotId: robot.id,
          ownerAccountId: ownerAccount.id,
          ownerAddress: ownerAccount.address,
          rates: robot.rates,
          surgeBps: candidate.surgeBps,
          movesCompleted: 0,
        });
      }
    } catch (error) {
      // Reserving is all or nothing: an order holding two of its three robots cannot be
      // fulfilled, so give back what was taken rather than stranding a robot or a balance.
      for (const leg of legs) {
        await this.fleet.release(leg.robotId, false);
      }
      await this.ledger.releaseHold({
        holdId: hold.id,
        groupId: `hold-release:${rentalId}`,
        reason: 'order could not reserve a robot for every leg',
      });
      throw error;
    }

    const startedAt = Date.now();
    legs[0]!.startedAt = startedAt;

    const rental: Rental = {
      id: rentalId,
      renterAccountId: renter.id,
      status: 'active',
      holdId: hold.id,
      authorizedAmount: authorization,
      legs,
      movesCompleted: 0,
      startedAt,
    };

    await this.rentals.put(rental);

    this.events.append({
      rentalId,
      kind: 'rental_started',
      label: 'Authorization held',
      detail: 'Covers all three legs running their full allowance',
      amount: authorization,
      phase: 'authorize',
    });

    for (const leg of legs) {
      this.events.append({
        rentalId,
        kind: 'robot_assigned',
        label: `${legFor(leg.class_).name}: Robot #${leg.robotId}`,
        detail: `${describeLeg(legFor(leg.class_))} at ${(leg.surgeBps / 10_000).toFixed(2)}x`,
        phase: 'authorize',
      });
    }

    return rental;
  }

  /**
   * Records progress. The robot reports finished moves; the clock is the marketplace's own,
   * so a fare cannot drift away from the time actually spent.
   */
  async recordMeter(rentalId: string, progress: { movesCompleted: number }): Promise<Rental> {
    const rental = await this.requireRental(rentalId);
    if (rental.status !== 'active') throw new LedgerConflict(`Rental ${rentalId} is ${rental.status}`);

    const target = Math.min(MOVES_PER_ORDER, Math.max(rental.movesCompleted, progress.movesCompleted));
    const updated = this.advanceTo(rental, target);
    await this.rentals.put(updated);

    // The whole order is done once the last robot sets the parcel down.
    if (updated.movesCompleted >= MOVES_PER_ORDER) return this.completeRental(rentalId);
    return updated;
  }

  /**
   * Stops every meter and bills the order. Finishing the work is what triggers the charge:
   * leaving a completed order waiting for an instruction would strand the held balance.
   */
  async completeRental(rentalId: string, progress?: { movesCompleted: number }): Promise<Rental> {
    const rental = await this.requireRental(rentalId);
    if (rental.status === 'settled' || rental.status === 'cancelled') return rental;

    const target = Math.min(
      MOVES_PER_ORDER,
      Math.max(rental.movesCompleted, progress?.movesCompleted ?? rental.movesCompleted),
    );

    const advanced = this.advanceTo(rental, target);
    const endedAt = Date.now();

    const legs = advanced.legs.map((leg) => ({
      ...leg,
      // A leg that was still running when the order stopped is billed up to now; one that
      // never started is billed for nothing.
      endedAt: leg.endedAt ?? (leg.startedAt === undefined ? undefined : endedAt),
    }));

    const completed: Rental = { ...advanced, legs, status: 'completed', endedAt };
    await this.rentals.put(completed);

    this.events.append({
      rentalId,
      kind: 'rental_completed',
      label: 'Order complete',
      detail: `${completed.movesCompleted} of ${MOVES_PER_ORDER} moves finished`,
      phase: 'work',
    });

    return this.settleRental(rentalId);
  }

  /**
   * Captures the fare, pays each robot owner their leg, and takes the platform fee.
   *
   * The ledger is written first and the transfers carry the settlement group id, so a
   * transfer that has to be retried reconciles against exactly one set of entries.
   */
  async settleRental(rentalId: string): Promise<Rental> {
    const rental = await this.requireRental(rentalId);
    if (rental.status === 'settled') return rental;
    if (rental.status !== 'completed') throw new LedgerConflict(`Rental ${rentalId} is ${rental.status}`);

    const priced = settleOrder({
      legs: rental.legs.map((leg) => ({
        rates: leg.rates,
        surgeBps: leg.surgeBps,
        meteredMinutes: this.legMinutes(leg),
        tasksCompleted: leg.movesCompleted >= MOVES_PER_TASK ? 1 : 0,
      })),
      platformFeeBps: this.config.marketplace.platformFeeBps,
      authorizedAmount: rental.authorizedAmount,
    });

    const settlementGroup = `settle:${rentalId}`;
    const settledLegs = rental.legs.map((leg, index) => ({
      ...leg,
      fare: priced.legs[index]!.fare,
      platformFee: priced.legs[index]!.platformFee,
      ownerPayout: priced.legs[index]!.ownerPayout,
    }));

    await this.ledger.captureAndDistribute({
      holdId: rental.holdId,
      fare: priced.total,
      platformFee: priced.platformFee,
      payouts: settledLegs.map((leg) => ({
        accountId: leg.ownerAccountId,
        amount: leg.ownerPayout!,
      })),
      revenueAccountId: this.platform.revenueAccountId,
      groupId: settlementGroup,
    });

    this.events.append({
      rentalId,
      kind: 'fare_captured',
      label: 'Fare captured',
      detail: `${rental.legs.length} legs over ${Math.ceil(this.orderMinutes(rental))} min`,
      amount: priced.total,
      phase: 'settle',
    });

    const released = rental.authorizedAmount - priced.total;
    if (released > 0n) {
      this.events.append({
        rentalId,
        kind: 'hold_released',
        label: 'Unused authorization released',
        detail: 'Returned to the renter available balance',
        amount: released,
        phase: 'settle',
      });
    }

    const renter = await this.ledger.requireAccount(rental.renterAccountId);
    const revenue = await this.ledger.requireAccount(this.platform.revenueAccountId);

    for (const leg of settledLegs) {
      if (!leg.ownerPayout || leg.ownerPayout <= 0n) continue;

      const owner = await this.ledger.requireAccount(leg.ownerAccountId);
      const receipt = await this.wallets.transferUsdc({
        walletId: renter.walletId,
        destinationAddress: owner.address,
        amount: leg.ownerPayout,
        idempotencyKey: `${settlementGroup}:payout:${leg.class_}`,
        refId: rentalId,
      });

      this.events.append({
        rentalId,
        kind: 'payout_transferred',
        label: `${legFor(leg.class_).name} owner paid`,
        detail: `Robot #${leg.robotId} · ${owner.address}`,
        amount: leg.ownerPayout,
        transactionId: receipt.transactionId,
        txHash: receipt.txHash,
        phase: 'settle',
      });
      this.resolveTxHash(receipt.transactionId);

      // A direct owner has already been paid to their own address. Crediting the ledger and
      // stopping there would show a spendable platform balance that no wallet backs.
      if (owner.payoutMode === 'direct') {
        await this.ledger.recordWithdrawal({
          accountId: owner.id,
          amount: leg.ownerPayout,
          groupId: `${settlementGroup}:direct-payout:${leg.class_}`,
          transactionId: receipt.transactionId,
          destination: owner.address,
        });
      }
    }

    if (priced.platformFee > 0n) {
      const receipt = await this.wallets.transferUsdc({
        walletId: renter.walletId,
        destinationAddress: revenue.address,
        amount: priced.platformFee,
        idempotencyKey: `${settlementGroup}:fee`,
        refId: rentalId,
      });

      this.events.append({
        rentalId,
        kind: 'fee_transferred',
        label: 'Platform fee taken',
        detail: 'USDC transferred to the revenue wallet',
        amount: priced.platformFee,
        transactionId: receipt.transactionId,
        txHash: receipt.txHash,
        phase: 'settle',
      });
      this.resolveTxHash(receipt.transactionId);
    }

    for (const leg of settledLegs) {
      await this.fleet.release(leg.robotId, true);
    }

    const settled: Rental = {
      ...rental,
      legs: settledLegs,
      status: 'settled',
      fare: priced.total,
      platformFee: priced.platformFee,
      settlementRef: settlementGroup,
    };

    await this.rentals.put(settled);

    this.events.append({
      rentalId,
      kind: 'rental_settled',
      label: 'Settlement recorded',
      detail: `${settledLegs.length} owners paid`,
      phase: 'settle',
    });

    return settled;
  }

  /** Voids an order that produced no billable work and returns the authorization. */
  async cancelRental(rentalId: string, reason: string): Promise<Rental> {
    const rental = await this.requireRental(rentalId);
    if (rental.status === 'settled') throw new LedgerConflict(`Rental ${rentalId} is already settled`);
    if (rental.status === 'cancelled') return rental;

    await this.ledger.releaseHold({ holdId: rental.holdId, groupId: `cancel:${rentalId}`, reason });

    for (const leg of rental.legs) {
      await this.fleet.release(leg.robotId, false);
    }

    const cancelled: Rental = { ...rental, status: 'cancelled', endedAt: Date.now() };
    await this.rentals.put(cancelled);

    this.events.append({
      rentalId,
      kind: 'rental_cancelled',
      label: 'Order cancelled',
      detail: reason,
      amount: rental.authorizedAmount,
      phase: 'settle',
    });

    return cancelled;
  }

  async getRental(rentalId: string): Promise<Rental | undefined> {
    return this.rentals.get(rentalId);
  }

  async listByRenter(accountId: string): Promise<Rental[]> {
    return this.rentals.listByRenter(accountId);
  }

  timeline(rentalId: string) {
    return this.events.list(rentalId);
  }

  /**
   * Advances the order to a move count, logging each move and handing over between legs.
   *
   * A leg's clock starts when the previous one sets the item down, so each owner is billed
   * for their own stretch rather than the whole order's duration.
   */
  private advanceTo(rental: Rental, target: number): Rental {
    if (target <= rental.movesCompleted) return rental;

    const legs = rental.legs.map((leg) => ({ ...leg }));
    const now = Date.now();

    for (let move = rental.movesCompleted; move < target; move += 1) {
      const legIndex = Math.floor(move / MOVES_PER_TASK);
      const leg = legs[legIndex];
      if (!leg) break;

      leg.startedAt ??= now;
      leg.movesCompleted = (move % MOVES_PER_TASK) + 1;

      const step = legFor(leg.class_).moves[move % MOVES_PER_TASK]!;
      this.events.append({
        rentalId: rental.id,
        kind: 'meter_recorded',
        label: `${legFor(leg.class_).name} · move ${step.step}`,
        detail: step.label,
        phase: 'work',
      });

      // The leg is finished, so its clock stops and the next robot's begins.
      if (leg.movesCompleted >= MOVES_PER_TASK) {
        leg.endedAt = now;
        const next = legs[legIndex + 1];
        if (next) next.startedAt ??= now;
      }
    }

    return { ...rental, legs, movesCompleted: target };
  }

  /** Prices a robot per class without claiming any of them. */
  private async candidateRobots() {
    const robots = await this.fleet.list();
    const chosen = [];

    for (const class_ of ORDER_CLASSES) {
      const pick = robots.find((robot) => robot.class_ === class_ && robot.status === 1);
      if (!pick) throw new LedgerConflict(`No ${legFor(class_).name} robot is available`);

      const availability = await this.fleet.availability(class_);
      chosen.push({
        class_,
        robotId: pick.id,
        owner: pick.owner,
        rates: pick.rates,
        surgeBps: surgeBps(availability),
      });
    }

    return chosen;
  }

  /** Billable runtime for one leg, capped at the ceiling the authorization was sized against. */
  private legMinutes(leg: RentalLeg, now = Date.now()): number {
    if (leg.startedAt === undefined) return 0;

    const elapsed = Math.max(0, ((leg.endedAt ?? now) - leg.startedAt) / 60_000);
    return Math.min(elapsed, this.config.marketplace.maxBillableMinutes);
  }

  private orderMinutes(rental: Rental, now = Date.now()): number {
    return Math.max(0, ((rental.endedAt ?? now) - rental.startedAt) / 60_000);
  }

  /**
   * Waits for a transfer to land and fills its hash into the event log.
   *
   * Deliberately not awaited: settlement should not block on a confirmation, and an order
   * whose hash never resolves is still correctly settled.
   */
  private resolveTxHash(transactionId: string): void {
    try {
      void this.wallets
        .waitForTransaction(transactionId)
        .then((confirmed) => {
          if (confirmed.txHash) this.events.attachTxHash(transactionId, confirmed.txHash);
        })
        .catch(() => {
          // A failed confirmation is visible in the ledger and in Circle; the link is cosmetic.
        });
    } catch {
      // Settlement has already happened. Nothing about a missing link is worth throwing over.
    }
  }

  private async requireRental(rentalId: string): Promise<Rental> {
    const rental = await this.rentals.get(rentalId);
    if (!rental) throw new LedgerConflict(`Unknown rental ${rentalId}`);
    return rental;
  }

  private async resolveOwnerAccount(address: `0x${string}`) {
    const accountId = await this.directory.ownerAccountIdFor(address);
    if (!accountId) throw new LedgerConflict(`No owner account registered for ${address}`);
    return this.ledger.requireAccount(accountId);
  }
}
