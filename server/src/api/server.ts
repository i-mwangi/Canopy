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
import { describeLeg, legFor, ZONE_LABELS } from '../rental/legs.ts';
import { StubChain, StubWalletGateway, stubConfig, STUB_OWNER_ADDRESS } from '../stub/fakes.ts';

const ROBOT_CLASS_NAMES = ['Picking', 'Packing', 'Delivery'] as const;

/** One task is one run of the class's leg; the UI shows the moves it is made of. */
function renderLeg(class_: 0 | 1 | 2) {
  const leg = legFor(class_);
  return {
    name: leg.name,
    from: ZONE_LABELS[leg.from],
    to: ZONE_LABELS[leg.to],
    description: describeLeg(leg),
    moves: leg.moves,
  };
}
const ROBOT_STATUS_NAMES = ['Unlisted', 'Available', 'Rented', 'Maintenance'] as const;

function renderRental(rental: Rental) {
  return {
    id: rental.id,
    onChainId: rental.onChainId?.toString(),
    robotId: rental.robotId.toString(),
    class: ROBOT_CLASS_NAMES[rental.class_],
    leg: renderLeg(rental.class_),
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
  // Two independent stubs. STUB_MODE fakes everything for a walkthrough with no credentials.
  // STUB_CHAIN fakes only the registry and rental manager, so real USDC still moves through
  // Circle while there is nothing deployed to point at.
  const stubbedWallets = process.env.STUB_MODE === 'true';
  const stubbedChain = stubbedWallets || process.env.STUB_CHAIN === 'true';

  const config = stubbedWallets ? stubConfig() : loadConfig();

  const wallets = stubbedWallets ? (new StubWalletGateway() as never) : new CircleWalletGateway(config);
  const ledger = new Ledger(new InMemoryLedgerStore());
  const directory = new InMemoryAccountDirectory();

  const walletSetId = stubbedWallets
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

  // The stub fleet needs one owner so settlement has somewhere to pay. With real wallets that
  // owner gets a real one, so earnings land somewhere the money can actually be seen.
  let chain: RentalChain;
  if (stubbedChain) {
    const owner = stubbedWallets
      ? await ledger.openAccount({
          role: 'owner',
          walletId: 'stub-fleet-owner',
          address: STUB_OWNER_ADDRESS,
        })
      : (await accounts.onboardOwner()).account;

    await directory.registerOwner(owner.address, owner.id);
    chain = new StubChain(owner.address) as never as RentalChain;
    console.log(`stub chain: fleet owner ${owner.address}`);
  } else {
    chain = new RentalChain(config, wallets);
  }

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

  const seedRenterAmount = process.env.SEED_RENTER_USDC
    ? toMinorUnits(process.env.SEED_RENTER_USDC)
    : 0n;

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
    if (stubbedWallets) {
      await accounts.creditDeposit({
        accountId: result.account.id,
        amount: await wallets.getUsdcBalance(result.account.walletId),
        transactionId: `stub-seed-${result.account.id}`,
      });
    } else if (seedRenterAmount > 0n) {
      // Optional convenience for testnet: move a float from the operating wallet so a new
      // renter can dispatch a job without visiting a faucet first.
      await accounts.fundFromOperating({
        accountId: result.account.id,
        operatingAccountId: platform.operatingAccountId,
        amount: seedRenterAmount,
      });
    }

    res.status(201).json({ accountId: result.account.id, depositAddress: result.depositAddress });
  });

  /** Rebinds a renter account to a wallet this account already controls. */
  app.post('/accounts/renters/adopt', async (req, res) => {
    const result = await accounts.adoptRenter(String(req.body.address ?? '') as `0x${string}`);
    res.status(201).json({
      accountId: result.account.id,
      depositAddress: result.depositAddress,
      available: toDecimalString(result.account.available),
    });
  });

  app.post('/accounts/owners', async (_req, res) => {
    const result = await accounts.onboardOwner();
    res.status(201).json({ accountId: result.account.id, payoutAddress: result.depositAddress });
  });

  /**
   * Registers an owner who already controls the address their robots are listed under.
   * Earnings are paid to that address at settlement rather than banked with the platform.
   */
  app.post('/accounts/owners/link', async (req, res) => {
    const account = await accounts.linkOwner(String(req.body.address ?? '') as `0x${string}`);
    res.status(201).json({
      accountId: account.id,
      address: account.address,
      payoutMode: account.payoutMode,
    });
  });

  app.get('/accounts/:accountId/balance', async (req, res) => {
    const balance = await accounts.balance(req.params.accountId);
    res.json({
      available: toDecimalString(balance.available),
      held: toDecimalString(balance.held),
      total: toDecimalString(balance.total),
    });
  });

  /** Credits a deposit that landed on chain without a notification reaching the server. */
  app.post('/accounts/:accountId/deposits/sync', async (req, res) => {
    const result = await accounts.syncDeposits(req.params.accountId);
    res.json({
      credited: toDecimalString(result.credited),
      onChain: toDecimalString(result.onChain),
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

  /** The fixed route every job follows, so the floor plan and the fleet agree on the model. */
  app.get('/floor-plan', async (_req, res) => {
    res.json({
      zones: ZONE_LABELS,
      legs: [0, 1, 2].map((class_) => ({
        class: ROBOT_CLASS_NAMES[class_ as 0 | 1 | 2],
        ...renderLeg(class_ as 0 | 1 | 2),
      })),
    });
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
        leg: renderLeg(robot.class_),
      })),
    );
  });

  app.post('/rentals/quote', async (req, res) => {
    const quote = await rentals.quote({
      robotId: BigInt(req.body.robotId),
      estimatedTasks: Number(req.body.estimatedTasks ?? 0),
    });

    res.json({
      robotId: quote.robotId.toString(),
      surgeBps: quote.surgeBps,
      estimatedFare: toDecimalString(quote.fare.total),
      platformFee: toDecimalString(quote.fare.platformFee),
      ownerPayout: toDecimalString(quote.fare.ownerPayout),
      authorizationHold: toDecimalString(quote.authorization),
      maxBillableMinutes: quote.maxBillableMinutes,
      perMinute: toDecimalString(quote.rates.perMinute),
    });
  });

  app.post('/rentals', async (req, res) => {
    const rental = await rentals.startRental({
      robotId: BigInt(req.body.robotId),
      renterAccountId: req.body.renterAccountId,
      estimatedTasks: Number(req.body.estimatedTasks ?? 0),
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
        transactionId: event.transactionId,
        txHash: event.txHash,
        phase: event.phase,
        createdAt: event.createdAt,
      })),
    );
  });

  /** Called by the robot connectivity layer as work progresses. */
  app.post('/rentals/:rentalId/meter', async (req, res) => {
    const rental = await rentals.recordMeter(req.params.rentalId, {
      tasksCompleted: Number(req.body.tasksCompleted ?? 0),
    });
    res.json(renderRental(rental));
  });

  app.post('/rentals/:rentalId/complete', async (req, res) => {
    const rental = await rentals.completeRental(req.params.rentalId, {
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
