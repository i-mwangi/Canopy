import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    authorizationAmount,
    quoteFare,
    splitFare,
    surgeBps,
    type RateCard,
} from '../src/pricing/fare.ts';
import { parseReportedAmount, toMinorUnits } from '../src/config.ts';

const usdc = toMinorUnits;

const rates: RateCard = {
  baseFare: usdc('2'),
  perMinute: usdc('0.25'),
  perTask: usdc('0.5'),
  minimumFare: usdc('3'),
};

describe('parseReportedAmount', () => {
  it('reads an amount an upstream API reports', () => {
    assert.equal(parseReportedAmount('20'), usdc('20'));
    assert.equal(parseReportedAmount('8.70'), usdc('8.70'));
  });

  it('truncates precision the ledger does not keep rather than refusing the balance', () => {
    // The native token on Arc carries 18 decimals; the ledger keeps six.
    assert.equal(parseReportedAmount('20.000000000000000000'), usdc('20'));
    assert.equal(parseReportedAmount('1.2345678901234'), usdc('1.234567'));
  });

  it('still rejects something that is not a number', () => {
    assert.throws(() => parseReportedAmount('not-a-balance'));
  });
});

describe('surge', () => {
  it('prices at 1.0x while at least half the fleet is free', () => {
    assert.equal(surgeBps({ availableRobots: 10, totalRobots: 10 }), 10_000);
    assert.equal(surgeBps({ availableRobots: 5, totalRobots: 10 }), 10_000);
  });

  it('climbs as the fleet fills up', () => {
    const light = surgeBps({ availableRobots: 3, totalRobots: 10 });
    const heavy = surgeBps({ availableRobots: 1, totalRobots: 10 });

    assert.ok(light > 10_000);
    assert.ok(heavy > light);
  });

  it('is capped so an empty fleet cannot produce a runaway quote', () => {
    assert.equal(surgeBps({ availableRobots: 0, totalRobots: 10 }, { maxBps: 20_000 }), 20_000);
  });

  it('falls back to 1.0x for an empty registry', () => {
    assert.equal(surgeBps({ availableRobots: 0, totalRobots: 0 }), 10_000);
  });
});

describe('quoteFare', () => {
  it('adds base, time, and task components', () => {
    const fare = quoteFare({
      rates,
      reading: { meteredMinutes: 12, tasksCompleted: 4 },
      surgeBps: 10_000,
      platformFeeBps: 1_500,
    });

    assert.equal(fare.timeFare, usdc('3'));
    assert.equal(fare.taskFare, usdc('2'));
    assert.equal(fare.subtotal, usdc('7'));
    assert.equal(fare.total, usdc('7'));
    assert.equal(fare.platformFee, usdc('1.05'));
    assert.equal(fare.ownerPayout, usdc('5.95'));
  });

  it('applies surge to the whole subtotal', () => {
    const fare = quoteFare({
      rates,
      reading: { meteredMinutes: 12, tasksCompleted: 4 },
      surgeBps: 15_000,
      platformFeeBps: 0,
    });

    assert.equal(fare.total, usdc('10.5'));
    assert.equal(fare.surgeAmount, usdc('3.5'));
  });

  it('rounds partial minutes up so a robot is never used for free', () => {
    const fare = quoteFare({
      rates,
      reading: { meteredMinutes: 4.2, tasksCompleted: 0 },
      surgeBps: 10_000,
      platformFeeBps: 0,
    });

    assert.equal(fare.timeFare, usdc('1.25'));
  });

  it('floors at the minimum fare', () => {
    const fare = quoteFare({
      rates,
      reading: { meteredMinutes: 0, tasksCompleted: 0 },
      surgeBps: 10_000,
      platformFeeBps: 0,
    });

    assert.equal(fare.total, usdc('3'));
  });

  it('splits the fare without losing a unit', () => {
    const fare = quoteFare({
      rates,
      reading: { meteredMinutes: 7, tasksCompleted: 3 },
      surgeBps: 13_700,
      platformFeeBps: 1_500,
    });

    assert.equal(fare.platformFee + fare.ownerPayout, fare.total);
    assert.equal(fare.platformFee % 10_000n, 0n, 'fee must land on a whole cent');
  });
});

describe('splitFare', () => {
  it('keeps the fee and the payout summing to the fare exactly', () => {
    for (const fare of ['8.70', '5', '0.01', '13.33', '99.99', '2.505']) {
      const { platformFee, ownerPayout } = splitFare(usdc(fare), 1_500);
      assert.equal(platformFee + ownerPayout, usdc(fare), `split of ${fare} did not balance`);
    }
  });

  it('rounds the fee to a whole cent so a receipt column adds up', () => {
    // 15% of 8.70 is 1.305, which would otherwise display as 1.31 beside a 7.40 payout.
    const { platformFee, ownerPayout } = splitFare(usdc('8.70'), 1_500);

    assert.equal(platformFee, usdc('1.31'));
    assert.equal(ownerPayout, usdc('7.39'));
    assert.equal(platformFee % 10_000n, 0n, 'fee is not a whole number of cents');
    assert.equal(ownerPayout % 10_000n, 0n, 'payout is not a whole number of cents');
  });

  it('rounds a sub-cent fee down to nothing rather than taking a fraction', () => {
    const { platformFee, ownerPayout } = splitFare(usdc('0.02'), 1_500);

    assert.equal(platformFee, 0n);
    assert.equal(ownerPayout, usdc('0.02'));
  });

  it('never takes more than the fare', () => {
    const { platformFee, ownerPayout } = splitFare(usdc('0.01'), 3_000);

    assert.ok(platformFee <= usdc('0.01'));
    assert.equal(platformFee + ownerPayout, usdc('0.01'));
  });
});

describe('authorizationAmount', () => {
  it('holds more than the estimate so an overrun still settles', () => {
    const estimate = { meteredMinutes: 20, tasksCompleted: 5 };

    const expected = quoteFare({ rates, reading: estimate, surgeBps: 10_000, platformFeeBps: 0 }).total;
    const hold = authorizationAmount({ rates, estimate, surgeBps: 10_000, bufferBps: 13_000 });

    assert.ok(hold > expected);
    assert.equal(hold, (expected * 13_000n) / 10_000n);
  });
});
