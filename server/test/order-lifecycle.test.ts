import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { toMinorUnits, type AppConfig } from '../src/config.ts';
import { Ledger } from '../src/ledger/ledger.ts';
import { InMemoryLedgerStore } from '../src/ledger/memory-store.ts';
import { LedgerConflict } from '../src/ledger/types.ts';
import type { RateCard } from '../src/pricing/fare.ts';
import type { OnChainRobot, RobotClass } from '../src/chain/rental-chain.ts';
import {
  InMemoryAccountDirectory,
  InMemoryRentalStore,
  RentalService,
  MOVES_PER_ORDER,
} from '../src/rental/service.ts';
import { RentalEventLog } from '../src/rental/events.ts';

const usdc = toMinorUnits;

const RATES: Record<RobotClass, RateCard> = {
  0: { baseFare: usdc('2'), perMinute: usdc('0.35'), perTask: usdc('0.60'), minimumFare: usdc('3') },
  1: { baseFare: usdc('1.5'), perMinute: usdc('0.25'), perTask: usdc('0.45'), minimumFare: usdc('2.5') },
  2: { baseFare: usdc('3'), perMinute: usdc('0.5'), perTask: usdc('0.9'), minimumFare: usdc('4') },
};

const OWNER_ADDRESSES: Record<RobotClass, `0x${string}`> = {
  0: '0x00000000000000000000000000000000000000a0',
  1: '0x00000000000000000000000000000000000000b0',
  2: '0x00000000000000000000000000000000000000c0',
};

const config = {
  marketplace: {
    platformFeeBps: 1_500,
    authorizationBufferBps: 13_000,
    operatingFloatCeiling: usdc('25000'),
    operatingFloatFloor: usdc('5000'),
    minimumDeposit: usdc('1'),
    minimumWithdrawal: usdc('5'),
    maxBillableMinutes: 5,
  },
} as AppConfig;

/** One robot per class, each belonging to a different owner. */
class FakeChain {
  readonly cancelled: bigint[] = [];
  private nextRentalId = 0n;
  private available = 3;

  setAvailable(count: number): void {
    this.available = count;
  }

  async listRobots(): Promise<OnChainRobot[]> {
    return ([0, 1, 2] as RobotClass[]).map((class_) => ({
      id: BigInt(class_),
      owner: OWNER_ADDRESSES[class_],
      class_,
      status: 1,
      rates: RATES[class_],
      metadataUri: `stub://robot/${class_}`,
      completedRentals: 0,
    }));
  }

  async getRobot(robotId: bigint): Promise<OnChainRobot> {
    return (await this.listRobots())[Number(robotId)]!;
  }

  async getFleetAvailability(): Promise<{ availableRobots: number; totalRobots: number }> {
    return { availableRobots: this.available, totalRobots: 3 };
  }

  async startRental(): Promise<bigint> {
    return this.nextRentalId++;
  }

  async recordMeter(): Promise<void> {}
  async completeRental(): Promise<void> {}
  async settleRental(): Promise<void> {}

  async cancelRental(rentalId: bigint): Promise<void> {
    this.cancelled.push(rentalId);
  }
}

class FakeWallets {
  readonly transfers: { to: string; amount: bigint; idempotencyKey: string }[] = [];

  async transferUsdc(params: { destinationAddress: string; amount: bigint; idempotencyKey: string }) {
    this.transfers.push({
      to: params.destinationAddress,
      amount: params.amount,
      idempotencyKey: params.idempotencyKey,
    });
    return { transactionId: `tx-${this.transfers.length}`, state: 'COMPLETE' };
  }

  async waitForTransaction(transactionId: string) {
    return { transactionId, state: 'COMPLETE', txHash: `0xhash-${transactionId}` };
  }
}

describe('order lifecycle', () => {
  let ledger: Ledger;
  let chain: FakeChain;
  let wallets: FakeWallets;
  let service: RentalService;
  let renterId: string;
  let revenueId: string;
  let ownerIds: string[];

  beforeEach(async () => {
    ledger = new Ledger(new InMemoryLedgerStore());
    wallets = new FakeWallets();
    chain = new FakeChain();

    const renter = await ledger.openAccount({
      role: 'renter',
      walletId: 'w-renter',
      address: '0x00000000000000000000000000000000000000bb',
    });
    const revenue = await ledger.openAccount({
      role: 'revenue',
      walletId: 'w-revenue',
      address: '0x00000000000000000000000000000000000000cc',
    });

    renterId = renter.id;
    revenueId = revenue.id;

    const directory = new InMemoryAccountDirectory();
    ownerIds = [];

    // Three separate owners, which is the whole point of settling leg by leg.
    for (const class_ of [0, 1, 2] as RobotClass[]) {
      const owner = await ledger.openAccount({
        role: 'owner',
        walletId: `w-owner-${class_}`,
        address: OWNER_ADDRESSES[class_],
      });
      await directory.registerOwner(OWNER_ADDRESSES[class_], owner.id);
      ownerIds.push(owner.id);
    }

    service = new RentalService(
      config,
      ledger,
      new InMemoryRentalStore(),
      chain as never,
      wallets as never,
      { treasuryAccountId: revenue.id, operatingAccountId: revenue.id, revenueAccountId: revenue.id },
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

  it('reserves one robot per class', async () => {
    const order = await service.startRental({ renterAccountId: renterId });

    assert.equal(order.legs.length, 3);
    assert.deepEqual(
      order.legs.map((leg) => leg.class_),
      [0, 1, 2],
    );
    assert.equal(new Set(order.legs.map((leg) => leg.ownerAccountId)).size, 3, 'three distinct owners');
  });

  it('holds enough for all three legs to run their full allowance', async () => {
    const order = await service.startRental({ renterAccountId: renterId });

    const balance = await ledger.balanceOf(renterId);
    assert.equal(balance.held, order.authorizedAmount);
    assert.ok(order.authorizedAmount > usdc('10'), 'a three-leg order holds more than one leg would');
  });

  it('runs the legs in sequence, a move at a time', async () => {
    const order = await service.startRental({ renterAccountId: renterId });

    const afterFirst = await service.recordMeter(order.id, { movesCompleted: 1 });
    assert.equal(afterFirst.legs[0]!.movesCompleted, 1);
    assert.equal(afterFirst.legs[1]!.movesCompleted, 0, 'the second robot has not started');

    const afterPick = await service.recordMeter(order.id, { movesCompleted: 2 });
    assert.ok(afterPick.legs[0]!.endedAt, 'the picking leg is finished');
    assert.ok(afterPick.legs[1]!.startedAt, 'the packing leg has taken over');
  });

  it('settles once the sixth move lands, with no instruction to press', async () => {
    const order = await service.startRental({ renterAccountId: renterId });
    const settled = await service.recordMeter(order.id, { movesCompleted: MOVES_PER_ORDER });

    assert.equal(settled.status, 'settled');
    assert.equal((await ledger.balanceOf(renterId)).held, 0n);
  });

  it('pays each robot owner for their own leg', async () => {
    const order = await service.startRental({ renterAccountId: renterId });
    const settled = await service.recordMeter(order.id, { movesCompleted: MOVES_PER_ORDER });

    for (const [index, ownerId] of ownerIds.entries()) {
      const balance = await ledger.balanceOf(ownerId);
      assert.equal(balance.available, settled.legs[index]!.ownerPayout, `owner ${index} paid their leg`);
      assert.ok(balance.available > 0n);
    }

    // Three payouts plus one fee.
    assert.equal(wallets.transfers.length, 4);
  });

  it('keeps the owner shares and the fee adding up to the fare', async () => {
    const order = await service.startRental({ renterAccountId: renterId });
    const settled = await service.recordMeter(order.id, { movesCompleted: MOVES_PER_ORDER });

    const paidOut = settled.legs.reduce((sum, leg) => sum + leg.ownerPayout!, 0n);
    assert.equal(paidOut + settled.platformFee!, settled.fare);

    const charged = usdc('100') - (await ledger.balanceOf(renterId)).available;
    assert.equal(charged, settled.fare, 'the renter is charged exactly the fare');
  });

  it('bills a leg only for its own stretch of the order', async () => {
    const order = await service.startRental({ renterAccountId: renterId });
    const settled = await service.recordMeter(order.id, { movesCompleted: MOVES_PER_ORDER });

    // Every leg ran a fraction of a minute, so none is charged for the order's whole duration.
    for (const leg of settled.legs) {
      assert.ok(leg.fare! > 0n);
      assert.ok(leg.fare! < usdc('10'), 'a leg is not charged for the whole order');
    }
  });

  it('never bills above the authorization', async () => {
    const order = await service.startRental({ renterAccountId: renterId });
    const settled = await service.completeRental(order.id, { movesCompleted: MOVES_PER_ORDER });

    assert.ok(settled.fare! <= order.authorizedAmount);
  });

  it('returns the whole hold when an order is cancelled', async () => {
    const order = await service.startRental({ renterAccountId: renterId });
    await service.cancelRental(order.id, 'robot faulted before pickup');

    const balance = await ledger.balanceOf(renterId);
    assert.equal(balance.available, usdc('100'));
    assert.equal(balance.held, 0n);
    assert.equal(wallets.transfers.length, 0);
    assert.equal(chain.cancelled.length, 3, 'every reserved robot is released');
  });

  it('settles only once when asked again', async () => {
    const order = await service.startRental({ renterAccountId: renterId });
    const settled = await service.recordMeter(order.id, { movesCompleted: MOVES_PER_ORDER });
    await service.settleRental(order.id);

    assert.equal(wallets.transfers.length, 4);
    assert.equal((await ledger.balanceOf(ownerIds[0]!)).available, settled.legs[0]!.ownerPayout);
  });

  it('will not open an order the renter cannot cover', async () => {
    const poor = await ledger.openAccount({
      role: 'renter',
      walletId: 'w-poor',
      address: '0x00000000000000000000000000000000000000dd',
    });

    await assert.rejects(() => service.startRental({ renterAccountId: poor.id }), /available/);
  });

  it('releases the hold and every robot when a leg cannot be reserved', async () => {
    const failing = new FakeChain();
    let calls = 0;
    failing.startRental = async () => {
      calls += 1;
      if (calls > 2) throw new Error('chain unavailable');
      return BigInt(calls);
    };

    const directory = new InMemoryAccountDirectory();
    for (const [index, class_] of ([0, 1, 2] as RobotClass[]).entries()) {
      await directory.registerOwner(OWNER_ADDRESSES[class_], ownerIds[index]!);
    }

    const isolated = new RentalService(
      config,
      ledger,
      new InMemoryRentalStore(),
      failing as never,
      wallets as never,
      { treasuryAccountId: revenueId, operatingAccountId: revenueId, revenueAccountId: revenueId },
      directory,
      new RentalEventLog(),
    );

    await assert.rejects(() => isolated.startRental({ renterAccountId: renterId }), /chain unavailable/);

    const balance = await ledger.balanceOf(renterId);
    assert.equal(balance.available, usdc('100'), 'no balance may stay held');
    assert.equal(balance.held, 0n);
    assert.equal(failing.cancelled.length, 2, 'the robots already taken are released');
  });

  it('prices a scarce fleet higher than an idle one', async () => {
    chain.setAvailable(3);
    const cheap = await service.quote();

    chain.setAvailable(1);
    const dear = await service.quote();

    assert.ok(dear.authorization > cheap.authorization);
  });

  it('refuses to settle an order that is still running', async () => {
    const order = await service.startRental({ renterAccountId: renterId });
    await assert.rejects(() => service.settleRental(order.id), LedgerConflict);
  });
});
