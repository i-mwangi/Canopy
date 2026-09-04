import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { toMinorUnits, type AppConfig } from '../src/config.ts';
import { Ledger } from '../src/ledger/ledger.ts';
import { InMemoryLedgerStore } from '../src/ledger/memory-store.ts';
import { LedgerConflict } from '../src/ledger/types.ts';
import type { MeterReading, RateCard } from '../src/pricing/fare.ts';
import type { OnChainRobot, RobotClass } from '../src/chain/rental-chain.ts';
import {
  InMemoryAccountDirectory,
  InMemoryRentalStore,
  RentalService,
} from '../src/rental/service.ts';
import { RentalEventLog } from '../src/rental/events.ts';

const usdc = toMinorUnits;

const rates: RateCard = {
  baseFare: usdc('2'),
  perMinute: usdc('0.25'),
  perTask: usdc('0.5'),
  minimumFare: usdc('2'),
};

const config = {
  marketplace: {
    platformFeeBps: 1_500,
    authorizationBufferBps: 13_000,
    operatingFloatCeiling: usdc('25000'),
    operatingFloatFloor: usdc('5000'),
    minimumDeposit: usdc('1'),
    minimumWithdrawal: usdc('5'),
  },
} as AppConfig;

/** Stands in for the registry and rental manager on chain. */
class FakeChain {
  readonly calls: string[] = [];
  private nextRentalId = 0n;
  private available = 4;

  constructor(private readonly owner: `0x${string}`) {}

  setAvailable(count: number): void {
    this.available = count;
  }

  async getRobot(robotId: bigint): Promise<OnChainRobot> {
    return {
      id: robotId,
      owner: this.owner,
      class_: 0 as RobotClass,
      status: 1,
      rates,
      metadataUri: 'ipfs://robot',
      completedRentals: 12,
    };
  }

  async getFleetAvailability(): Promise<{ availableRobots: number; totalRobots: number }> {
    return { availableRobots: this.available, totalRobots: 4 };
  }

  async startRental(): Promise<bigint> {
    this.calls.push('start');
    return this.nextRentalId++;
  }

  async recordMeter(): Promise<void> {
    this.calls.push('meter');
  }

  async completeRental(): Promise<void> {
    this.calls.push('complete');
  }

  async settleRental(_id: bigint, fare: bigint): Promise<void> {
    this.calls.push(`settle:${fare}`);
  }

  async cancelRental(): Promise<void> {
    this.calls.push('cancel');
  }
}

/** Records the transfers settlement would submit, without touching the network. */
class FakeWallets {
  readonly transfers: { walletId: string; to: string; amount: bigint; idempotencyKey: string }[] = [];
  failNext = false;

  async transferUsdc(params: {
    walletId: string;
    destinationAddress: `0x${string}`;
    amount: bigint;
    idempotencyKey: string;
  }) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('transfer rejected');
    }

    this.transfers.push({
      walletId: params.walletId,
      to: params.destinationAddress,
      amount: params.amount,
      idempotencyKey: params.idempotencyKey,
    });

    return { transactionId: `tx-${this.transfers.length}`, state: 'COMPLETE' };
  }
}

describe('rental lifecycle', () => {
  let ledger: Ledger;
  let chain: FakeChain;
  let wallets: FakeWallets;
  let service: RentalService;
  let renterId: string;
  let ownerId: string;
  let revenueId: string;
  let ownerAddress: `0x${string}`;

  beforeEach(async () => {
    ledger = new Ledger(new InMemoryLedgerStore());
    wallets = new FakeWallets();

    ownerAddress = '0x00000000000000000000000000000000000000aa';
    chain = new FakeChain(ownerAddress);

    const renter = await ledger.openAccount({
      role: 'renter',
      walletId: 'w-renter',
      address: '0x00000000000000000000000000000000000000bb',
    });
    const owner = await ledger.openAccount({ role: 'owner', walletId: 'w-owner', address: ownerAddress });
    const revenue = await ledger.openAccount({
      role: 'revenue',
      walletId: 'w-revenue',
      address: '0x00000000000000000000000000000000000000cc',
    });
    const treasury = await ledger.openAccount({
      role: 'treasury',
      walletId: 'w-treasury',
      address: '0x00000000000000000000000000000000000000dd',
    });
    const operating = await ledger.openAccount({
      role: 'operating',
      walletId: 'w-operating',
      address: '0x00000000000000000000000000000000000000ee',
    });

    renterId = renter.id;
    ownerId = owner.id;
    revenueId = revenue.id;

    const directory = new InMemoryAccountDirectory();
    await directory.registerOwner(ownerAddress, owner.id);

    service = new RentalService(
      config,
      ledger,
      new InMemoryRentalStore(),
      chain as never,
      wallets as never,
      {
        treasuryAccountId: treasury.id,
        operatingAccountId: operating.id,
        revenueAccountId: revenue.id,
      },
      directory,
      new RentalEventLog(),
    );

    await ledger.recordDeposit({
      accountId: renterId,
      amount: usdc('100'),
      groupId: 'deposit:seed',
      transactionId: 'seed',
    });
  });

  const estimate: MeterReading = { meteredMinutes: 20, tasksCompleted: 4 };

  it('holds the buffered estimate rather than the bare quote', async () => {
    const rental = await service.startRental({ robotId: 1n, renterAccountId: renterId, estimate });

    // base 2 + 20 min at 0.25 + 4 tasks at 0.5 = 9, buffered by 30%.
    assert.equal(rental.authorizedAmount, usdc('11.7'));

    const balance = await ledger.balanceOf(renterId);
    assert.equal(balance.held, usdc('11.7'));
    assert.equal(balance.available, usdc('88.3'));
  });

  it('charges the metered fare and refunds the rest of the hold', async () => {
    const rental = await service.startRental({ robotId: 1n, renterAccountId: renterId, estimate });

    await service.recordMeter(rental.id, { meteredMinutes: 8, tasksCompleted: 2 });
    await service.completeRental(rental.id);
    const settled = await service.settleRental(rental.id);

    // base 2 + 8 min at 0.25 + 2 tasks at 0.5 = 5.
    assert.equal(settled.fare, usdc('5'));
    assert.equal(settled.platformFee, usdc('0.75'));
    assert.equal(settled.ownerPayout, usdc('4.25'));

    const renterBalance = await ledger.balanceOf(renterId);
    assert.equal(renterBalance.held, 0n);
    assert.equal(renterBalance.available, usdc('95'));

    assert.equal((await ledger.balanceOf(ownerId)).available, usdc('4.25'));
    assert.equal((await ledger.balanceOf(revenueId)).available, usdc('0.75'));
  });

  it('moves the split on chain from the renter wallet', async () => {
    const rental = await service.startRental({ robotId: 1n, renterAccountId: renterId, estimate });
    await service.completeRental(rental.id, { meteredMinutes: 8, tasksCompleted: 2 });
    await service.settleRental(rental.id);

    assert.equal(wallets.transfers.length, 2);
    assert.deepEqual(
      wallets.transfers.map((transfer) => transfer.amount),
      [usdc('4.25'), usdc('0.75')],
    );
    assert.ok(wallets.transfers.every((transfer) => transfer.walletId === 'w-renter'));
  });

  it('caps the fare at the authorization when a rental overruns', async () => {
    const rental = await service.startRental({ robotId: 1n, renterAccountId: renterId, estimate });
    await service.completeRental(rental.id, { meteredMinutes: 600, tasksCompleted: 50 });

    const settled = await service.settleRental(rental.id);
    assert.equal(settled.fare, rental.authorizedAmount);

    const balance = await ledger.balanceOf(renterId);
    assert.equal(balance.held, 0n);
  });

  it('prices a scarce fleet higher than an idle one', async () => {
    chain.setAvailable(4);
    const cheap = await service.quote({ robotId: 1n, estimate });

    chain.setAvailable(1);
    const dear = await service.quote({ robotId: 1n, estimate });

    assert.ok(dear.fare.total > cheap.fare.total);
    assert.ok(dear.surgeBps > cheap.surgeBps);
  });

  it('does not leave a spendable balance for an owner paid directly', async () => {
    // A linked owner controls the payout address themselves, so settlement pays them on
    // chain and the ledger must not also show a withdrawable platform balance.
    const linked = await ledger.openAccount({
      role: 'owner',
      walletId: '',
      address: ownerAddress,
      payoutMode: 'direct',
    });

    const directory = new InMemoryAccountDirectory();
    await directory.registerOwner(ownerAddress, linked.id);

    const direct = new RentalService(
      config,
      ledger,
      new InMemoryRentalStore(),
      chain as never,
      wallets as never,
      { treasuryAccountId: linked.id, operatingAccountId: linked.id, revenueAccountId: revenueId },
      directory,
      new RentalEventLog(),
    );

    const rental = await direct.startRental({ robotId: 1n, renterAccountId: renterId, estimate });
    await direct.completeRental(rental.id, { meteredMinutes: 8, tasksCompleted: 2 });
    const settled = await direct.settleRental(rental.id);

    assert.equal(settled.ownerPayout, usdc('4.25'));

    // The transfer still happened; the ledger just nets to zero rather than double-counting.
    assert.ok(wallets.transfers.some((transfer) => transfer.amount === usdc('4.25')));
    assert.equal((await ledger.balanceOf(linked.id)).available, 0n);

    const entries = await ledger.statement({ accountId: linked.id });
    assert.ok(entries.some((entry) => entry.kind === 'payout'));
    assert.ok(entries.some((entry) => entry.kind === 'withdrawal'));
  });

  it('returns the whole hold when a rental is cancelled', async () => {
    const rental = await service.startRental({ robotId: 1n, renterAccountId: renterId, estimate });
    await service.cancelRental(rental.id, 'robot faulted before pickup');

    const balance = await ledger.balanceOf(renterId);
    assert.equal(balance.available, usdc('100'));
    assert.equal(balance.held, 0n);
    assert.equal(wallets.transfers.length, 0);
    assert.ok(chain.calls.includes('cancel'));
  });

  it('settles only once when called again', async () => {
    const rental = await service.startRental({ robotId: 1n, renterAccountId: renterId, estimate });
    await service.completeRental(rental.id, { meteredMinutes: 8, tasksCompleted: 2 });

    await service.settleRental(rental.id);
    await service.settleRental(rental.id);

    assert.equal(wallets.transfers.length, 2);
    assert.equal((await ledger.balanceOf(ownerId)).available, usdc('4.25'));
  });

  it('refuses to settle a rental that is still running', async () => {
    const rental = await service.startRental({ robotId: 1n, renterAccountId: renterId, estimate });
    await assert.rejects(() => service.settleRental(rental.id), LedgerConflict);
  });

  it('will not open a rental the renter cannot cover', async () => {
    await assert.rejects(
      () =>
        service.startRental({
          robotId: 1n,
          renterAccountId: renterId,
          estimate: { meteredMinutes: 10_000, tasksCompleted: 0 },
        }),
      /available/,
    );
  });

  it('releases the hold when the rental cannot be opened on chain', async () => {
    const failing = new FakeChain(ownerAddress);
    failing.startRental = async () => {
      throw new Error('chain unavailable');
    };

    const directory = new InMemoryAccountDirectory();
    await directory.registerOwner(ownerAddress, ownerId);

    const isolated = new RentalService(
      config,
      ledger,
      new InMemoryRentalStore(),
      failing as never,
      wallets as never,
      { treasuryAccountId: ownerId, operatingAccountId: ownerId, revenueAccountId: revenueId },
      directory,
      new RentalEventLog(),
    );

    await assert.rejects(
      () => isolated.startRental({ robotId: 1n, renterAccountId: renterId, estimate }),
      /chain unavailable/,
    );

    const balance = await ledger.balanceOf(renterId);
    assert.equal(balance.available, usdc('100'));
    assert.equal(balance.held, 0n);
  });
});
