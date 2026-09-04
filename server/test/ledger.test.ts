import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { Ledger } from '../src/ledger/ledger.ts';
import { InMemoryLedgerStore } from '../src/ledger/memory-store.ts';
import { InsufficientFunds, LedgerConflict } from '../src/ledger/types.ts';
import { toMinorUnits } from '../src/config.ts';

const usdc = toMinorUnits;

describe('Ledger', () => {
  let ledger: Ledger;
  let renter: string;
  let owner: string;
  let revenue: string;

  beforeEach(async () => {
    ledger = new Ledger(new InMemoryLedgerStore());

    renter = (
      await ledger.openAccount({ role: 'renter', walletId: 'w-renter', address: '0xrenter' })
    ).id;
    owner = (await ledger.openAccount({ role: 'owner', walletId: 'w-owner', address: '0xowner' })).id;
    revenue = (
      await ledger.openAccount({ role: 'revenue', walletId: 'w-revenue', address: '0xrevenue' })
    ).id;
  });

  it('credits a deposit exactly once for a repeated notification', async () => {
    await ledger.recordDeposit({ accountId: renter, amount: usdc('100'), groupId: 'deposit:tx1', transactionId: 'tx1' });
    await ledger.recordDeposit({ accountId: renter, amount: usdc('100'), groupId: 'deposit:tx1', transactionId: 'tx1' });

    const balance = await ledger.balanceOf(renter);
    assert.equal(balance.available, usdc('100'));
    assert.equal(balance.held, 0n);
  });

  it('moves held funds out of the available balance', async () => {
    await ledger.recordDeposit({ accountId: renter, amount: usdc('100'), groupId: 'd1', transactionId: 'tx1' });
    await ledger.placeHold({ accountId: renter, rentalId: 'r1', amount: usdc('40'), groupId: 'h1' });

    const balance = await ledger.balanceOf(renter);
    assert.equal(balance.available, usdc('60'));
    assert.equal(balance.held, usdc('40'));
    assert.equal(balance.total, usdc('100'));
  });

  it('refuses a hold larger than the available balance', async () => {
    await ledger.recordDeposit({ accountId: renter, amount: usdc('10'), groupId: 'd1', transactionId: 'tx1' });

    await assert.rejects(
      () => ledger.placeHold({ accountId: renter, rentalId: 'r1', amount: usdc('25'), groupId: 'h1' }),
      InsufficientFunds,
    );
  });

  it('refuses a second hold on the same rental', async () => {
    await ledger.recordDeposit({ accountId: renter, amount: usdc('100'), groupId: 'd1', transactionId: 'tx1' });
    await ledger.placeHold({ accountId: renter, rentalId: 'r1', amount: usdc('10'), groupId: 'h1' });

    await assert.rejects(
      () => ledger.placeHold({ accountId: renter, rentalId: 'r1', amount: usdc('10'), groupId: 'h2' }),
      LedgerConflict,
    );
  });

  it('captures the fare, splits it, and returns the unused authorization', async () => {
    await ledger.recordDeposit({ accountId: renter, amount: usdc('100'), groupId: 'd1', transactionId: 'tx1' });
    const hold = await ledger.placeHold({
      accountId: renter,
      rentalId: 'r1',
      amount: usdc('50'),
      groupId: 'h1',
    });

    const result = await ledger.captureAndSplit({
      holdId: hold.id,
      fare: usdc('30'),
      platformFee: usdc('4.5'),
      ownerAccountId: owner,
      revenueAccountId: revenue,
      groupId: 'settle:r1',
    });

    assert.equal(result.ownerPayout, usdc('25.5'));
    assert.equal(result.released, usdc('20'));

    const renterBalance = await ledger.balanceOf(renter);
    assert.equal(renterBalance.available, usdc('70'));
    assert.equal(renterBalance.held, 0n);

    assert.equal((await ledger.balanceOf(owner)).available, usdc('25.5'));
    assert.equal((await ledger.balanceOf(revenue)).available, usdc('4.5'));
  });

  it('refuses to capture more than was authorized', async () => {
    await ledger.recordDeposit({ accountId: renter, amount: usdc('100'), groupId: 'd1', transactionId: 'tx1' });
    const hold = await ledger.placeHold({
      accountId: renter,
      rentalId: 'r1',
      amount: usdc('20'),
      groupId: 'h1',
    });

    await assert.rejects(
      () =>
        ledger.captureAndSplit({
          holdId: hold.id,
          fare: usdc('25'),
          platformFee: 0n,
          ownerAccountId: owner,
          revenueAccountId: revenue,
          groupId: 'settle:r1',
        }),
      LedgerConflict,
    );
  });

  it('refuses to capture a hold twice', async () => {
    await ledger.recordDeposit({ accountId: renter, amount: usdc('100'), groupId: 'd1', transactionId: 'tx1' });
    const hold = await ledger.placeHold({
      accountId: renter,
      rentalId: 'r1',
      amount: usdc('20'),
      groupId: 'h1',
    });

    const capture = {
      holdId: hold.id,
      fare: usdc('10'),
      platformFee: 0n,
      ownerAccountId: owner,
      revenueAccountId: revenue,
      groupId: 'settle:r1',
    };

    await ledger.captureAndSplit(capture);
    await assert.rejects(() => ledger.captureAndSplit({ ...capture, groupId: 'settle:r1:retry' }), LedgerConflict);
  });

  it('returns the whole authorization when a rental is cancelled', async () => {
    await ledger.recordDeposit({ accountId: renter, amount: usdc('100'), groupId: 'd1', transactionId: 'tx1' });
    const hold = await ledger.placeHold({
      accountId: renter,
      rentalId: 'r1',
      amount: usdc('40'),
      groupId: 'h1',
    });

    await ledger.releaseHold({ holdId: hold.id, groupId: 'cancel:r1', reason: 'robot never started' });

    const balance = await ledger.balanceOf(renter);
    assert.equal(balance.available, usdc('100'));
    assert.equal(balance.held, 0n);
  });

  it('will not let held funds be withdrawn', async () => {
    await ledger.recordDeposit({ accountId: renter, amount: usdc('100'), groupId: 'd1', transactionId: 'tx1' });
    await ledger.placeHold({ accountId: renter, rentalId: 'r1', amount: usdc('80'), groupId: 'h1' });

    await assert.rejects(
      () =>
        ledger.recordWithdrawal({
          accountId: renter,
          amount: usdc('50'),
          groupId: 'wd1',
          destination: '0xelsewhere',
        }),
      InsufficientFunds,
    );
  });

  it('serialises concurrent holds so the balance cannot be spent twice', async () => {
    await ledger.recordDeposit({ accountId: renter, amount: usdc('100'), groupId: 'd1', transactionId: 'tx1' });

    const results = await Promise.allSettled([
      ledger.placeHold({ accountId: renter, rentalId: 'r1', amount: usdc('60'), groupId: 'h1' }),
      ledger.placeHold({ accountId: renter, rentalId: 'r2', amount: usdc('60'), groupId: 'h2' }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    assert.equal(fulfilled.length, 1, 'only one of two competing holds may succeed');

    const balance = await ledger.balanceOf(renter);
    assert.equal(balance.held, usdc('60'));
    assert.equal(balance.available, usdc('40'));
  });
});
