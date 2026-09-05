import { randomUUID } from 'node:crypto';

import type { AppConfig } from '../config.ts';
import type { CircleWalletGateway } from '../circle/client.ts';
import type { Ledger } from '../ledger/ledger.ts';
import { LedgerConflict } from '../ledger/types.ts';
import {
  authorizationAmount,
  quoteFare,
  splitFare,
  surgeBps,
  type MeterReading,
  type RateCard,
} from '../pricing/fare.ts';
import type { RentalChain } from '../chain/rental-chain.ts';
import type { RentalEventLog } from './events.ts';

export type RentalStatus = 'active' | 'completed' | 'settled' | 'cancelled';

export type Rental = {
  id: string;
  onChainId?: bigint;
  robotId: bigint;
  renterAccountId: string;
  ownerAccountId: string;
  status: RentalStatus;
  holdId: string;
  authorizedAmount: bigint;
  surgeBps: number;
  rates: RateCard;
  reading: MeterReading;
  startedAt: number;
  endedAt?: number;
  fare?: bigint;
  platformFee?: bigint;
  ownerPayout?: bigint;
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
    private readonly chain: RentalChain,
    private readonly wallets: CircleWalletGateway,
    private readonly platform: PlatformAccounts,
    private readonly directory: AccountDirectory,
    private readonly events: RentalEventLog,
  ) {}

  /**
   * Prices a prospective rental without reserving anything.
   *
   * Only the task count is asked for. Runtime is measured while the robot works, so quoting a
   * time here would be inventing a number the renter cannot know and would not be billed on.
   */
  async quote(params: { robotId: bigint; estimatedTasks: number }) {
    const robot = await this.chain.getRobot(params.robotId);
    const fleet = await this.chain.getFleetAvailability(robot.class_);
    const surge = surgeBps(fleet);
    const { maxBillableMinutes } = this.config.marketplace;

    // The fare shown before dispatch is the floor: tasks and base only, no runtime yet.
    const fare = quoteFare({
      rates: robot.rates,
      reading: { meteredMinutes: 0, tasksCompleted: params.estimatedTasks },
      surgeBps: surge,
      platformFeeBps: this.config.marketplace.platformFeeBps,
    });

    const authorization = authorizationAmount({
      rates: robot.rates,
      estimatedTasks: params.estimatedTasks,
      maxBillableMinutes,
      surgeBps: surge,
      bufferBps: this.config.marketplace.authorizationBufferBps,
    });

    return {
      robotId: params.robotId,
      rates: robot.rates,
      surgeBps: surge,
      fare,
      authorization,
      maxBillableMinutes,
    };
  }

  /**
   * Opens a rental: reserves the estimated fare against the renter's balance, then records
   * the rental on chain. The hold is ledger-only, so no funds move until the meter stops.
   */
  async startRental(params: {
    robotId: bigint;
    renterAccountId: string;
    estimatedTasks: number;
  }): Promise<Rental> {
    const renter = await this.ledger.requireAccount(params.renterAccountId);
    if (renter.role !== 'renter') throw new LedgerConflict(`Account ${renter.id} is not a renter account`);

    const quote = await this.quote({ robotId: params.robotId, estimatedTasks: params.estimatedTasks });
    const robot = await this.chain.getRobot(params.robotId);
    const ownerAccount = await this.resolveOwnerAccount(robot.owner);

    const rentalId = randomUUID();
    const hold = await this.ledger.placeHold({
      accountId: renter.id,
      rentalId,
      amount: quote.authorization,
      groupId: `hold:${rentalId}`,
    });

    let onChainId: bigint;
    try {
      onChainId = await this.chain.startRental({
        robotId: params.robotId,
        renter: renter.address,
        authorizedAmount: quote.authorization,
        surgeBps: quote.surgeBps,
        holdRef: hold.id,
      });
    } catch (error) {
      await this.ledger.releaseHold({
        holdId: hold.id,
        groupId: `hold-release:${rentalId}`,
        reason: 'rental could not be opened on chain',
      });
      throw error;
    }

    const rental: Rental = {
      id: rentalId,
      onChainId,
      robotId: params.robotId,
      renterAccountId: renter.id,
      ownerAccountId: ownerAccount.id,
      status: 'active',
      holdId: hold.id,
      authorizedAmount: quote.authorization,
      surgeBps: quote.surgeBps,
      rates: robot.rates,
      reading: { meteredMinutes: 0, tasksCompleted: 0 },
      startedAt: Date.now(),
    };

    await this.rentals.put(rental);

    this.events.append({
      rentalId,
      kind: 'rental_started',
      label: 'Authorization held',
      detail: 'Covers the tasks requested plus the longest run that can be billed',
      amount: quote.authorization,
      phase: 'authorize',
    });
    this.events.append({
      rentalId,
      kind: 'robot_assigned',
      label: `Robot #${params.robotId} assigned`,
      detail: `Rental #${onChainId} opened at ${(quote.surgeBps / 10_000).toFixed(2)}x`,
      phase: 'authorize',
    });

    return rental;
  }

  /**
   * Records progress from the robot.
   *
   * The robot reports what it finished; how long it has been running is the marketplace's own
   * clock. Taking runtime from the caller would let a fare drift away from the time actually
   * spent, which is the one number both sides can check.
   */
  async recordMeter(rentalId: string, progress: { tasksCompleted: number }): Promise<Rental> {
    const rental = await this.requireRental(rentalId);
    if (rental.status !== 'active') throw new LedgerConflict(`Rental ${rentalId} is ${rental.status}`);

    const next: MeterReading = {
      meteredMinutes: this.runtimeMinutes(rental),
      tasksCompleted: Math.max(rental.reading.tasksCompleted, progress.tasksCompleted),
    };

    if (rental.onChainId !== undefined) {
      await this.chain.recordMeter(rental.onChainId, next);
    }

    const updated: Rental = { ...rental, reading: next };
    await this.rentals.put(updated);

    this.events.append({
      rentalId,
      kind: 'meter_recorded',
      label: 'Meter reading',
      detail: `${Math.ceil(next.meteredMinutes)} min · ${next.tasksCompleted} tasks`,
      phase: 'work',
    });

    return updated;
  }

  /**
   * Stops the meter and fixes the billable runtime at the elapsed time. Nothing is charged
   * until `settleRental` runs.
   */
  async completeRental(rentalId: string, progress?: { tasksCompleted: number }): Promise<Rental> {
    const rental = await this.requireRental(rentalId);
    if (rental.status !== 'active') throw new LedgerConflict(`Rental ${rentalId} is ${rental.status}`);

    const reading: MeterReading = {
      meteredMinutes: this.runtimeMinutes(rental),
      tasksCompleted: Math.max(rental.reading.tasksCompleted, progress?.tasksCompleted ?? 0),
    };

    if (rental.onChainId !== undefined) {
      await this.chain.completeRental(rental.onChainId, reading);
    }

    const updated: Rental = { ...rental, status: 'completed', reading, endedAt: Date.now() };
    await this.rentals.put(updated);

    this.events.append({
      rentalId,
      kind: 'rental_completed',
      label: 'Meter stopped',
      detail: `Final reading ${Math.ceil(reading.meteredMinutes)} min · ${reading.tasksCompleted} tasks`,
      phase: 'work',
    });

    return updated;
  }

  /**
   * Captures the fare, splits it, moves the USDC, and writes the result back on chain.
   *
   * The ledger is authoritative and is written first. The on-chain transfers that follow
   * carry the settlement group id, so a transfer that has to be retried reconciles against
   * exactly one set of ledger entries.
   */
  async settleRental(rentalId: string): Promise<Rental> {
    const rental = await this.requireRental(rentalId);
    if (rental.status === 'settled') return rental;
    if (rental.status !== 'completed') throw new LedgerConflict(`Rental ${rentalId} is ${rental.status}`);

    const fare = quoteFare({
      rates: rental.rates,
      reading: rental.reading,
      surgeBps: rental.surgeBps,
      platformFeeBps: this.config.marketplace.platformFeeBps,
    });

    const billed = fare.total > rental.authorizedAmount ? rental.authorizedAmount : fare.total;
    const { platformFee } = splitFare(billed, this.config.marketplace.platformFeeBps);
    const settlementGroup = `settle:${rentalId}`;

    const { ownerPayout } = await this.ledger.captureAndSplit({
      holdId: rental.holdId,
      fare: billed,
      platformFee,
      ownerAccountId: rental.ownerAccountId,
      revenueAccountId: this.platform.revenueAccountId,
      groupId: settlementGroup,
    });

    const renter = await this.ledger.requireAccount(rental.renterAccountId);
    const owner = await this.ledger.requireAccount(rental.ownerAccountId);
    const revenue = await this.ledger.requireAccount(this.platform.revenueAccountId);

    this.events.append({
      rentalId,
      kind: 'fare_captured',
      label: 'Fare captured',
      detail: `Metered fare charged against the authorization`,
      amount: billed,
      phase: 'settle',
    });

    const released = rental.authorizedAmount - billed;
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

    if (ownerPayout > 0n) {
      const receipt = await this.wallets.transferUsdc({
        walletId: renter.walletId,
        destinationAddress: owner.address,
        amount: ownerPayout,
        idempotencyKey: `${settlementGroup}:payout`,
        refId: rentalId,
      });

      this.events.append({
        rentalId,
        kind: 'payout_transferred',
        label: 'Owner paid',
        detail:
          owner.payoutMode === 'direct'
            ? `USDC transferred to ${owner.address}, an address the owner controls`
            : `USDC transferred to ${owner.address}`,
        amount: ownerPayout,
        transactionId: receipt.transactionId,
        txHash: receipt.txHash,
        phase: 'settle',
      });
      this.resolveTxHash(receipt.transactionId);

      // A direct owner has already been paid to their own address. Crediting the ledger and
      // stopping there would show a spendable platform balance that no wallet backs, and a
      // later withdrawal would pay them a second time out of the float.
      if (owner.payoutMode === 'direct') {
        await this.ledger.recordWithdrawal({
          accountId: owner.id,
          amount: ownerPayout,
          groupId: `${settlementGroup}:direct-payout`,
          transactionId: receipt.transactionId,
          destination: owner.address,
        });
      }
    }

    if (platformFee > 0n) {
      const receipt = await this.wallets.transferUsdc({
        walletId: renter.walletId,
        destinationAddress: revenue.address,
        amount: platformFee,
        idempotencyKey: `${settlementGroup}:fee`,
        refId: rentalId,
      });

      this.events.append({
        rentalId,
        kind: 'fee_transferred',
        label: 'Platform fee taken',
        detail: `USDC transferred to the revenue wallet`,
        amount: platformFee,
        transactionId: receipt.transactionId,
        txHash: receipt.txHash,
        phase: 'settle',
      });
      this.resolveTxHash(receipt.transactionId);
    }

    if (rental.onChainId !== undefined) {
      await this.chain.settleRental(rental.onChainId, billed, settlementGroup);
    }

    this.events.append({
      rentalId,
      kind: 'rental_settled',
      label: 'Settlement recorded on chain',
      detail: `Rental #${rental.onChainId} closed`,
      phase: 'settle',
    });

    const settled: Rental = {
      ...rental,
      status: 'settled',
      fare: billed,
      platformFee,
      ownerPayout,
      settlementRef: settlementGroup,
    };

    await this.rentals.put(settled);
    return settled;
  }

  /** Voids a rental that produced no billable work and returns the authorization. */
  async cancelRental(rentalId: string, reason: string): Promise<Rental> {
    const rental = await this.requireRental(rentalId);
    if (rental.status === 'settled') throw new LedgerConflict(`Rental ${rentalId} is already settled`);
    if (rental.status === 'cancelled') return rental;

    await this.ledger.releaseHold({
      holdId: rental.holdId,
      groupId: `cancel:${rentalId}`,
      reason,
    });

    if (rental.onChainId !== undefined) {
      await this.chain.cancelRental(rental.onChainId, reason);
    }

    const cancelled: Rental = { ...rental, status: 'cancelled', endedAt: Date.now() };
    await this.rentals.put(cancelled);

    this.events.append({
      rentalId,
      kind: 'rental_cancelled',
      label: 'Rental cancelled',
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
   * Waits for a transfer to land and fills its hash into the event log.
   *
   * Deliberately not awaited: settlement should not block on a confirmation, and a rental
   * whose hash never resolves is still correctly settled — the link simply stays absent.
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

  /**
   * Billable runtime so far, capped at the ceiling the authorization was sized against. A
   * rental left open overnight bills the cap, not the whole night.
   */
  private runtimeMinutes(rental: Rental, now = Date.now()): number {
    const elapsed = Math.max(0, (now - rental.startedAt) / 60_000);
    return Math.min(elapsed, this.config.marketplace.maxBillableMinutes);
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
