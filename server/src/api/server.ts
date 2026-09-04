import { pathToFileURL } from 'node:url';

import express, { type NextFunction, type Request, type Response } from 'express';

import { loadConfig, toDecimalString, toMinorUnits } from '../config.ts';
import { CircleWalletGateway } from '../circle/client.ts';
import { TreasuryManager } from '../circle/treasury.ts';
import { RentalChain } from '../chain/rental-chain.ts';
import { Ledger } from '../ledger/ledger.ts';
import { InMemoryLedgerStore } from '../ledger/memory-store.ts';
import { InsufficientFunds, LedgerConflict } from '../ledger/types.ts';
import { AccountService } from '../rental/accounts.ts';
import {
  InMemoryAccountDirectory,
  InMemoryRentalStore,
  RentalService,
  type PlatformAccounts,
  type Rental,
} from '../rental/service.ts';
import { RentalEventLog } from '../rental/events.ts';
import { StubChain, StubWalletGateway, stubConfig, STUB_OWNER_ADDRESS } from '../stub/fakes.ts';

const ROBOT_CLASS_NAMES = ['Picking', 'Packing', 'Delivery'] as const;
const ROBOT_STATUS_NAMES = ['Unlisted', 'Available', 'Rented', 'Maintenance'] as const;

function renderRental(rental: Rental) {
  return {
    id: rental.id,
    onChainId: rental.onChainId?.toString(),
    robotId: rental.robotId.toString(),
    status: rental.status,
    surgeBps: rental.surgeBps,
    authorized: toDecimalString(rental.authorizedAmount),
    meter: rental.reading,
    fare: rental.fare === undefined ? undefined : toDecimalString(rental.fare),
    platformFee: rental.platformFee === undefined ? undefined : toDecimalString(rental.platformFee),
    ownerPayout: rental.ownerPayout === undefined ? undefined : toDecimalString(rental.ownerPayout),
    settlementRef: rental.settlementRef,
    startedAt: rental.startedAt,
    endedAt: rental.endedAt,
  };
}

export async function createServer() {
  const stubbed = process.env.STUB_MODE === 'true';
  const config = stubbed ? stubConfig() : loadConfig();

  const wallets = stubbed ? (new StubWalletGateway() as never) : new CircleWalletGateway(config);
  const ledger = new Ledger(new InMemoryLedgerStore());
  const directory = new InMemoryAccountDirectory();

  const stubChain = stubbed ? new StubChain(STUB_OWNER_ADDRESS) : null;
  const chain = stubChain ? (stubChain as never as RentalChain) : new RentalChain(config, wallets);

  const walletSetId = stubbed
    ? await wallets.createWalletSet()
    : (process.env.CIRCLE_WALLET_SET_ID ?? '');
  if (!walletSetId) throw new Error('CIRCLE_WALLET_SET_ID must be set; run the provision script first');

  const platform: PlatformAccounts = {
    treasuryAccountId: (
      await ledger.openAccount({
        role: 'treasury',
        walletId: process.env.TREASURY_WALLET_ID ?? 'stub-treasury',
        address: (process.env.TREASURY_WALLET_ADDRESS ?? '0x') as `0x${string}`,
      })
    ).id,
    operatingAccountId: (
      await ledger.openAccount({
        role: 'operating',
        walletId: process.env.OPERATING_WALLET_ID ?? 'stub-operating',
        address: (process.env.OPERATING_WALLET_ADDRESS ?? '0x') as `0x${string}`,
      })
    ).id,
    revenueAccountId: (
      await ledger.openAccount({
        role: 'revenue',
        walletId: process.env.REVENUE_WALLET_ID ?? 'stub-revenue',
        address: (process.env.REVENUE_WALLET_ADDRESS ?? '0x') as `0x${string}`,
      })
    ).id,
  };

  const accounts = new AccountService(config, wallets, ledger, directory, walletSetId);
  const eventLog = new RentalEventLog();
  const rentals = new RentalService(
    config,
    ledger,
    new InMemoryRentalStore(),
    chain,
    wallets,
    platform,
    directory,
    eventLog,
  );
  const treasury = new TreasuryManager(config, wallets, ledger, platform);

  // In stub mode every listed robot belongs to one owner account, so settlement has somewhere
  // to pay out to without an owner having to sign up first.
  if (stubbed) {
    const owner = await ledger.openAccount({
      role: 'owner',
      walletId: 'stub-fleet-owner',
      address: STUB_OWNER_ADDRESS,
    });
    await directory.registerOwner(STUB_OWNER_ADDRESS, owner.id);
  }

  const app = express();
  app.use(express.json());

  const allowedOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  app.use((req, res, next) => {
    res.setHeader('access-control-allow-origin', allowedOrigin);
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.post('/accounts/renters', async (_req, res) => {
    const result = await accounts.onboardRenter();

    // Stub renters start funded so the flow can be walked through without a real deposit.
    if (stubbed) {
      await accounts.creditDeposit({
        accountId: result.account.id,
        amount: await wallets.getUsdcBalance(result.account.walletId),
        transactionId: `stub-seed-${result.account.id}`,
      });
    }

    res.status(201).json({ accountId: result.account.id, depositAddress: result.depositAddress });
  });

  app.post('/accounts/owners', async (_req, res) => {
    const result = await accounts.onboardOwner();
    res.status(201).json({ accountId: result.account.id, payoutAddress: result.depositAddress });
  });

  app.get('/accounts/:accountId/balance', async (req, res) => {
    const balance = await accounts.balance(req.params.accountId);
    res.json({
      available: toDecimalString(balance.available),
      held: toDecimalString(balance.held),
      total: toDecimalString(balance.total),
    });
  });

  app.get('/accounts/:accountId/statement', async (req, res) => {
    const entries = await ledger.statement({ accountId: req.params.accountId });
    res.json(
      entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        amount: toDecimalString(entry.amount),
        heldDelta: toDecimalString(entry.heldDelta),
        rentalId: entry.rentalId,
        memo: entry.memo,
        createdAt: entry.createdAt,
      })),
    );
  });

  app.post('/accounts/:accountId/withdrawals', async (req, res) => {
    const result = await accounts.withdraw({
      accountId: req.params.accountId,
      amount: toMinorUnits(String(req.body.amount)),
      destinationAddress: req.body.destinationAddress,
    });

    res.status(202).json({
      transactionId: result.transactionId,
      amount: toDecimalString(result.amount),
    });
  });

  app.get('/accounts/:accountId/rentals', async (req, res) => {
    const owned = await rentals.listByRenter(req.params.accountId);
    res.json(owned.map(renderRental));
  });

  app.get('/robots', async (_req, res) => {
    const listed = await chain.listRobots();
    res.json(
      listed.map((robot) => ({
        id: robot.id.toString(),
        owner: robot.owner,
        class: ROBOT_CLASS_NAMES[robot.class_],
        status: ROBOT_STATUS_NAMES[robot.status] ?? 'Unlisted',
        rates: {
          baseFare: toDecimalString(robot.rates.baseFare),
          perMinute: toDecimalString(robot.rates.perMinute),
          perTask: toDecimalString(robot.rates.perTask),
          minimumFare: toDecimalString(robot.rates.minimumFare),
        },
        completedRentals: robot.completedRentals,
        metadataUri: robot.metadataUri,
      })),
    );
  });

  app.post('/rentals/quote', async (req, res) => {
    const quote = await rentals.quote({
      robotId: BigInt(req.body.robotId),
      estimate: {
        meteredMinutes: Number(req.body.estimatedMinutes ?? 0),
        tasksCompleted: Number(req.body.estimatedTasks ?? 0),
      },
    });

    res.json({
      robotId: quote.robotId.toString(),
      surgeBps: quote.surgeBps,
      estimatedFare: toDecimalString(quote.fare.total),
      platformFee: toDecimalString(quote.fare.platformFee),
      ownerPayout: toDecimalString(quote.fare.ownerPayout),
      authorizationHold: toDecimalString(quote.authorization),
    });
  });

  app.post('/rentals', async (req, res) => {
    const rental = await rentals.startRental({
      robotId: BigInt(req.body.robotId),
      renterAccountId: req.body.renterAccountId,
      estimate: {
        meteredMinutes: Number(req.body.estimatedMinutes ?? 0),
        tasksCompleted: Number(req.body.estimatedTasks ?? 0),
      },
    });

    res.status(201).json(renderRental(rental));
  });

  app.get('/rentals/:rentalId', async (req, res) => {
    const rental = await rentals.getRental(req.params.rentalId);
    if (!rental) {
      res.status(404).json({ error: 'unknown rental' });
      return;
    }
    res.json(renderRental(rental));
  });

  app.get('/rentals/:rentalId/events', async (req, res) => {
    res.json(
      rentals.timeline(req.params.rentalId).map((event) => ({
        id: event.id,
        kind: event.kind,
        label: event.label,
        detail: event.detail,
        amount: event.amount === undefined ? undefined : toDecimalString(event.amount),
        txHash: event.txHash,
        phase: event.phase,
        createdAt: event.createdAt,
      })),
    );
  });

  /** Called by the robot connectivity layer as work progresses. */
  app.post('/rentals/:rentalId/meter', async (req, res) => {
    const rental = await rentals.recordMeter(req.params.rentalId, {
      meteredMinutes: Number(req.body.meteredMinutes ?? 0),
      tasksCompleted: Number(req.body.tasksCompleted ?? 0),
    });
    res.json(renderRental(rental));
  });

  app.post('/rentals/:rentalId/complete', async (req, res) => {
    const rental = await rentals.completeRental(req.params.rentalId, {
      meteredMinutes: Number(req.body.meteredMinutes ?? 0),
      tasksCompleted: Number(req.body.tasksCompleted ?? 0),
    });
    res.json(renderRental(rental));
  });

  app.post('/rentals/:rentalId/settle', async (req, res) => {
    const rental = await rentals.settleRental(req.params.rentalId);
    res.json(renderRental(rental));
  });

  app.post('/rentals/:rentalId/cancel', async (req, res) => {
    const rental = await rentals.cancelRental(req.params.rentalId, String(req.body.reason ?? 'cancelled'));
    res.json(renderRental(rental));
  });

  /**
   * Circle notification sink. Inbound transfers to a renter wallet become deposits; the
   * transaction id is the idempotency key, so redelivery is safe.
   */
  app.post('/webhooks/circle', async (req, res) => {
    const notification = req.body?.notification;
    if (notification?.transactionType === 'INBOUND' && notification.state === 'COMPLETE') {
      const accountId = notification.refId;
      if (accountId) {
        await accounts.creditDeposit({
          accountId,
          amount: toMinorUnits(String(notification.amounts?.[0] ?? '0')),
          transactionId: notification.id,
        });
      }
    }
    res.status(204).end();
  });

  app.post('/treasury/rebalance', async (_req, res) => {
    const result = await treasury.rebalance();
    res.json({ action: result.action, amount: toDecimalString(result.amount), transactionId: result.transactionId });
  });

  app.get('/treasury/reconcile/:accountId', async (req, res) => {
    const result = await treasury.reconcile(req.params.accountId);
    res.json({
      ledger: toDecimalString(result.ledger),
      onChain: toDecimalString(result.onChain),
      drift: toDecimalString(result.drift),
    });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof InsufficientFunds) {
      res.status(402).json({ error: 'insufficient funds', detail: error.message });
      return;
    }
    if (error instanceof LedgerConflict) {
      res.status(409).json({ error: 'conflict', detail: error.message });
      return;
    }

    console.error(error);
    res.status(500).json({ error: 'internal error' });
  });

  return { app, config };
}

const entryPoint = process.argv[1];
const invokedDirectly = entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href;

if (invokedDirectly) {
  createServer()
    .then(({ app, config }) => {
      app.listen(config.server.port, () => {
        console.log(`listening on :${config.server.port}`);
      });
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
