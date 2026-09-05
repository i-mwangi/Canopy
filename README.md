# Canopy

A marketplace for renting warehouse robots by the minute, settled in USDC on Arc.

Fleet owners list robots and set a rate card. Renters dispatch a robot to a job, the meter runs
while the robot works, and the fare is charged when the job finishes — the same shape as a ride
hailing trip. Neither side ever holds a private key: every wallet is a Circle
developer-controlled wallet, and the platform signs on their behalf.

## How the money works

Custody sits with the platform. Incoming funds land in wallets the platform controls, balances
are tracked in a ledger, and USDC only moves on-chain at the moment a rental settles or a user
withdraws.

```
deposit ──▶ authorization hold ──▶ meter runs ──▶ capture fare ──▶ split ──▶ withdraw
            (ledger only)                         (on-chain USDC)
```

A hold is a ledger entry, not a transfer. That matters because the fare is not known when a
rental starts — locking a guessed amount on-chain would mean a second transaction and a refund
leg on every single rental. Instead the estimate plus a buffer is reserved against the renter's
balance, the meter runs, and exactly one settlement moves the real amount.

### Wallet topology

| Wallet | Role |
| --- | --- |
| `treasury` | Cold. Holds float that is not needed for day-to-day settlement. Never touched on the request path. |
| `operating` | Hot. Funds gas and keeps a working float. Swept to treasury above a ceiling, topped up below a floor. |
| `revenue` | Receives the platform fee from every settlement. |
| per-renter | Where a renter deposits. Debited at settlement. |
| per-owner | Where a custodial owner accrues earnings. Debited on withdrawal to an address they nominate. |

Owners come in two kinds. A **custodial** owner banks with the platform: `POST /accounts/owners`
creates a wallet, earnings accrue there, and they withdraw when they choose. A **linked** owner
already controls the address their robots are listed under — the account that signed the fleet
seed, say — so `POST /accounts/owners/link` registers them without creating a wallet, and
settlement pays that address directly. Their ledger balance nets to zero by design: crediting
the payout without also recording it as paid out would show a spendable balance no wallet backs,
and a later withdrawal would pay them twice out of the operating float.

USDC is the native gas token on Arc, so fares and fees are denominated in the same asset the
network charges in. Only the operating and settlement wallets need a gas float.

Arc exposes USDC twice: as the native 18-decimal gas token, and as a 6-decimal ERC-20 at
`0x3600…0000`. `CIRCLE_USDC_TOKEN_ID` must be the ERC-20 one — the ledger keeps six decimals
throughout, and gas comes out of the native balance without being asked for.

Wallets are created as EOAs. Smart contract accounts exist for gas sponsorship and batch
execution; since every wallet here holds the token that pays for gas, an SCA would add a
per-wallet deployment and a paymaster for nothing.

### Pricing

Fare = `(base + per-minute × minutes + per-task × tasks) × surge`, floored at the rate card
minimum. Runtime is **measured, not estimated**: the renter says how many tasks they need, and
the minutes come from the marketplace's own clock between dispatch and completion. Nothing the
caller sends can inflate them.

That moves the cost into the authorization. With no duration estimate to size against, the hold
has to cover the worst case — the tasks requested plus `MAX_BILLABLE_MINUTES` of runtime. Raise
that ceiling and jobs may run longer, but a renter needs a bigger balance before they can
dispatch at all. A rental left open past the ceiling bills the ceiling, not the whole night. Surge is derived from fleet occupancy: a class of robot prices at 1.0× while at least
half the fleet is free, and climbs quadratically as the pool empties, hard-capped so a nearly
empty fleet cannot produce a runaway quote.

Partial minutes round up. The platform fee is taken from the fare, so `fee + payout == fare`
exactly — no unit is created or lost in the split.

## Layout

```
contracts/
  src/RobotRegistry.sol    robots, owners, rate cards, per-class availability
  src/RentalManager.sol    rental lifecycle: start, meter, complete, settle, cancel
  test/                    Solidity tests for both contracts
  scripts/                 deploy and wire, seed a starting fleet
server/
  src/config.ts            environment, USDC minor-unit conversion
  src/circle/client.ts     Circle developer-controlled wallets gateway
  src/circle/treasury.ts   hot/cold float band and ledger-vs-chain reconciliation
  src/ledger/             balance authority: accounts, holds, entries
  src/pricing/fare.ts      rate cards, surge, fare quoting, authorization sizing
  src/rental/service.ts    rental orchestration
  src/rental/accounts.ts   onboarding, deposits, withdrawals
  src/chain/rental-chain.ts contract reads and operator-signed writes
  src/api/server.ts        HTTP surface
web/
  src/app/                 landing, fleet browser, rentals, live meter, wallet
  src/components/          robot card, rent modal, nav, status pills
  src/lib/                 API client, shared types, formatting
robot-agent/
  connectivity-layer/      Flask service: accepts jobs, meters them, reports back
  controllers/             robot-side controller, one per unit
```

### What is on-chain and what is not

The contracts are the *record*, not the vault. `RentalManager` stores what was agreed and what
was settled — the authorized amount, the meter readings, the final fare and its split — so a
robot owner can audit their earnings without trusting the platform's database. It never holds
funds. The `holdRef` and `settlementRef` fields are hashes of the off-chain identifiers, which
is what ties a row in the ledger to a rental on chain.

Every contract write is submitted from the settlement operator wallet. Renters and owners never
sign a transaction.

## The three processes

| Process | Port | Talks to |
| --- | --- | --- |
| `server` | 8080 | Circle, Arc RPC, and the browser |
| `web` | 3000 | `server` only |
| `robot-agent` | 5001 | `server`, and the robots |

Nothing but `server` holds a credential. The web app knows an account id; the robot agent knows
a shared token and a rental id. Neither can move money.

## Robot connectivity

The connectivity layer sits between the marketplace and the fleet. It accepts a dispatched job,
claims the robot so two rentals cannot drive the same unit, runs the tasks, and pushes meter
readings back on a fixed cadence.

```
POST /dispatch          {rentalId, robotId, robotClass, tasks}   marketplace → agent
POST /rentals/:id/meter {meteredMinutes, tasksCompleted}         agent → marketplace, every 15s
POST /rentals/:id/complete + /settle                             agent → marketplace, at the end
GET  /jobs/:rentalId    current reading and fault state
POST /jobs/:rentalId/abort
GET  /health            claimed robots and active job count
```

Readings are cumulative and monotonic, so a dropped or late-arriving one cannot corrupt the
fare — the next reading supersedes it. If the robot faults partway through, the agent cancels
the rental instead of completing it, and the renter's hold is released in full.

Two transport backends behind one interface, chosen with `ROBOT_BACKEND`:

- `file` — writes a command file per robot into a shared directory and waits for the controller
  to flip its status file. This is how a simulated fleet is driven, where the controller polls
  once per timestep.
- `http` — posts the task straight to a controller endpoint, which is how a physical unit behind
  a tunnel is driven.

`controllers/controller.py` is the robot side. It polls for a command, runs the motion, and
writes back `done` or `fault`. Swap `execute` for the real routine — an arm trajectory, a nav
goal, a conveyor run. It knows nothing about rentals, fares, or wallets.

```bash
cd robot-agent
pip install -r requirements.txt
cp .env.example .env

python controllers/controller.py --class Picking --id 0   # one per robot
python connectivity-layer/app.py                          # the agent
python test_connectivity.py                               # end-to-end check
```

## Stub mode

To click through the whole flow with no Circle account and nothing deployed:

```bash
cd server && STUB_MODE=true npm start   # :8080, in-memory Circle and Arc
cd web && npm run dev                   # :3000
```

The stub seeds a ten-robot fleet across the three classes (one per class down for maintenance,
so the grid is not uniform), funds each new renter with 500 USDC, and settles transfers
instantly. Every other code path is the real one — the same ledger, the same pricing, the same
rental service. Only the two outermost adapters are swapped.

The rental page carries an **Advance meter** button in stub mode, standing in for the robot
agent so a rental can be driven by hand.

### Real money, no contracts

`STUB_CHAIN=true` stubs only the registry and rental manager. Circle stays real, so USDC
actually moves between wallets while nothing needs to be deployed:

```bash
cd server && STUB_CHAIN=true SEED_RENTER_USDC=5 npm start
```

The stub fleet is then owned by a real Circle wallet, so settlement pays real earnings
somewhere they can be seen. `SEED_RENTER_USDC` moves a float from the operating wallet to each
new renter, which saves sending every tester to a faucet.

## Frontend

```bash
cd web
npm install
cp .env.example .env
npm run dev
```

Five screens: a landing page that opens a renter or owner account, a fleet browser with class
filters and live availability, a dispatch modal that re-quotes as you change the estimate, a
rental page, and a wallet with a deposit address, withdrawals, and a full activity ledger.

The rental page is the one that matters. It lays the job out in four panels: a rental and rate
card summary, a three-phase tracker (authorization, runtime, settlement), an ordered detail log
of every event with its transaction hash, a warehouse floor view carrying the live fare and
elapsed clock, and a settlement row showing the fare capture and both transfer legs.

The dispatch modal and the rental page both make the hold explicit — the fare shown while a job
runs is what you will be charged, and the authorization is labelled as a reservation rather than
a charge, because that distinction is the thing users get wrong about metered billing.

## Contracts

```bash
cd contracts
npm install
cp .env.example .env
npm test          # 19 Solidity tests, including a fuzz over the fee split
npm run build
```

Deploy needs an account with a USDC balance — USDC is the native gas token on Arc, so the
faucet funds gas and fares with the same asset. Fill `ARC_RPC_URL`, `DEPLOYER_PRIVATE_KEY` and
`SETTLEMENT_OPERATOR_ADDRESS` (the Circle wallet the server signs with), then:

```bash
npm run deploy
```

That deploys both contracts and wires them: the registry only accepts capacity claims from the
manager, and the manager only accepts lifecycle writes from the operator. Both grants happen
after deploy, and the script verifies them before printing the addresses to copy into
`server/.env`.

The registry deploys empty, so nothing appears on the browse page until a fleet is listed:

```bash
npm run seed
```

`listRobot` records `msg.sender` as the owner, so the account that signs the seed owns every
robot it lists and receives their earnings. Register that address with the server or settlement
has nowhere to pay out to:

```bash
curl -X POST localhost:8080/accounts/owners/link   -H 'content-type: application/json'   -d '{"address":"0x…"}'
```

## Setup

```bash
cd server
npm install
cp .env.example .env
```

Fill in `CIRCLE_API_KEY`, then:

```bash
npm run register-entity-secret
```

This generates a 32-byte entity secret, registers it with Circle, appends it to `.env`, and
writes a recovery file to `server/recovery/`. **The recovery file is downloadable once and is
the only way to reset a lost entity secret.** Move it to a secrets manager, store it separately
from the secret itself, and keep both out of version control — `recovery/` and `.env` are
already ignored. Rotate the secret roughly every 180 days.

Then provision the platform wallets:

```bash
npm run provision
```

Copy the printed wallet ids and addresses into `.env`, deploy the contracts, and fill in
`ROBOT_REGISTRY_ADDRESS` and `RENTAL_MANAGER_ADDRESS`. Call `setRentalManager` on the registry
and `setSettlementOperator` on the manager with the settlement operator wallet address, then
fund that wallet and the operating wallet with USDC.

```bash
npm start
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/accounts/renters` | Provision a renter wallet, returns a deposit address |
| `POST` | `/accounts/owners` | Provision an owner wallet, returns a payout address |
| `POST` | `/accounts/owners/link` | Register an owner at an address they already control |
| `GET` | `/accounts/:id/balance` | Available, held, and total balance |
| `GET` | `/accounts/:id/statement` | Ledger entries for the account |
| `POST` | `/accounts/:id/deposits/sync` | Credit a deposit that arrived without a notification |
| `POST` | `/accounts/renters/adopt` | Rebind a renter account to a wallet already controlled |
| `POST` | `/accounts/:id/withdrawals` | Pay out to a nominated address |
| `GET` | `/robots` | The listed fleet with rate cards and availability |
| `GET` | `/rentals/:id/events` | Ordered log of everything that happened to a rental |
| `GET` | `/accounts/:id/rentals` | Rentals opened by an account |
| `POST` | `/rentals/quote` | Price a rental without reserving anything |
| `POST` | `/rentals` | Place the hold and open the rental |
| `POST` | `/rentals/:id/meter` | Push a meter reading from the robot |
| `POST` | `/rentals/:id/complete` | Stop the meter |
| `POST` | `/rentals/:id/settle` | Capture the fare, split it, move the USDC |
| `POST` | `/rentals/:id/cancel` | Void the rental and release the hold |
| `POST` | `/webhooks/circle` | Inbound transfer notifications become deposits |
| `POST` | `/treasury/rebalance` | Sweep to treasury or top up the operating float |
| `GET` | `/treasury/reconcile/:id` | Compare the ledger against the on-chain balance |

## Tests

```bash
npm test
```

Covers the parts where a mistake costs money: deposits are credited once per transaction id,
held funds cannot be withdrawn or double-spent, concurrent holds against one balance serialise,
a fare can never exceed its authorization, settlement is idempotent, a cancelled rental returns
the full hold, and a rental that fails to open on-chain releases its hold rather than stranding
the renter's balance.

## Production notes

- `InMemoryLedgerStore` and `InMemoryRentalStore` are reference implementations. For real
  traffic, implement `LedgerStore` against a database with row locks and a unique index on
  `groupId` — that index is what makes deposit and settlement replay-safe. Nothing above the
  store interface changes.
- The entity secret belongs in a secrets manager or HSM, never in `.env` and never in logs.
- Deposits arrive through the Circle notification sink, which needs a public URL. Locally
  there isn't one, so `POST /accounts/:id/deposits/sync` reads the wallet balance and credits
  whatever the ledger cannot account for. Keep it in production as a backstop for a dropped
  webhook; it is idempotent on the observed balance.
- `POST /treasury/rebalance` and the reconcile endpoint should run on a schedule. A non-zero
  drift means USDC arrived that no ledger entry accounts for.
- The web app is served from `WEB_ORIGIN` (default `http://localhost:3000`), which is the only
  origin the API sets CORS headers for. Change it for a real deployment.
- Settlement writes the ledger before submitting transfers. If a transfer fails after the ledger
  is written, the settlement group id is a stable idempotency key, so the transfer can be retried
  against exactly one set of entries rather than re-running the capture.
