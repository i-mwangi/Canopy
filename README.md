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

### What an order is

An order is one item moved the whole way through the warehouse. It books **three robots, one
per class**, and they run in sequence because each hands the item to the next. The simulator
has one controller per class and each performs exactly one leg, so half a leg is not something
a robot can be asked to do.

| Class | Leg | Moves on the floor plan |
| --- | --- | --- |
| Picking | Product Rack → Collecting Area | 1 approach, 2 carry |
| Packing | Collecting Area → Packing Area | 3 approach, 4 carry |
| Delivery | Packing Area → Delivery Area | 5 approach, 6 carry |

Each move is reported as it finishes, so the floor plan fills one arrow at a time and the log
reads as the route the item took. The sixth move settles the order: there is nothing to press.

**Three robots means three owners.** Each leg is priced on its own robot's rate card and its own
surge, and each owner is paid for their leg alone — a leg's clock starts when the previous robot
sets the item down, so nobody is billed for another robot's time. The platform fee is taken per
leg, which is what keeps `Σ payouts + fee == fare` exact rather than approximately right.

Because an order holds three legs at once, the authorization is roughly three times a single
leg's. `MAX_BILLABLE_MINUTES` is the lever: it caps each leg, and raising it raises the balance
a renter needs before they can order at all.

### Pricing

Fare = `(base + per-minute × minutes + per-task × tasks) × surge`, floored at the rate card
minimum. Runtime is **measured, not estimated**: the renter says how many tasks they need, and
the minutes come from the marketplace's own clock between dispatch and completion. Nothing the
caller sends can inflate them.

That moves the cost into the authorization. With no duration estimate to size against, the hold
has to cover the worst case — the tasks requested plus `MAX_BILLABLE_MINUTES` of runtime. Raise
that ceiling and jobs may run longer, but a renter needs a bigger balance before they can
dispatch at all. A rental left open past the ceiling bills the ceiling, not the whole night.

Surge is derived from fleet occupancy: a class of robot prices at 1.0× while at least half the
fleet is free, and climbs quadratically as the pool empties, hard-capped so a nearly empty fleet
cannot produce a runaway quote.

Partial minutes round up. The platform fee is taken from the fare, so `fee + payout == fare`
exactly — no unit is created or lost in the split.

## Layout

```
server/
  src/config.ts            environment, USDC minor-unit conversion
  src/circle/client.ts     Circle developer-controlled wallets gateway
  src/circle/treasury.ts   hot/cold float band and ledger-vs-chain reconciliation
  src/ledger/             balance authority: accounts, holds, entries
  src/pricing/fare.ts      rate cards, surge, fare quoting, authorization sizing
  src/rental/service.ts    rental orchestration
  src/rental/accounts.ts   onboarding, deposits, withdrawals
  src/fleet/registry.ts    robots, owners, rate cards, availability
  src/api/server.ts        HTTP surface
web/
  src/app/                 landing, fleet browser, rentals, live meter, wallet
  src/components/          robot card, rent modal, nav, status pills
  src/lib/                 API client, shared types, formatting
robot-agent/
  connectivity-layer/      Flask service: accepts jobs, meters them, reports back
  controllers/             robot-side controller, one per unit
```

### Where the record lives

There are no smart contracts. Everything the marketplace knows — who owns which robot, what it
charges, which orders ran and how they settled — is the marketplace's own record, and the money
moves through Circle wallets. Arc is where the USDC lives, not where the logic does.

That is a deliberate trade. A contract would let an owner verify their earnings without
trusting this service; without one, they are trusting the operator's books. Everything else the
contracts were doing — the registry, the rate cards, the rental lifecycle — a database does
better and cheaper.

## The three processes

| Process | Port | Talks to |
| --- | --- | --- |
| `server` | 8080 | Circle and the browser |
| `web` | 3000 | `server` only |
| `robot-agent` | 5001 | `server`, and the robots |

Nothing but `server` holds a credential. The web app knows an account id; the robot agent knows
a shared token and a rental id. Neither can move money.

## Robot connectivity

Placing an order is the whole instruction. The marketplace dispatches the job the moment the
hold is placed, and the robots run the route on their own — nothing waits on the renter, who is
buying a finished delivery rather than a remote control. Point `ROBOT_AGENT_URL` at the
connectivity layer to drive a real fleet; leave it unset and the order still walks itself
through the six moves, one every `SIMULATED_MOVE_SECONDS`, so the marketplace can be exercised
end to end with no simulator running.

The connectivity layer sits between the marketplace and the fleet. It accepts a dispatched job,
claims a robot per leg so two orders cannot drive the same unit, runs the three legs in
sequence, and pushes meter readings back on a fixed cadence.

```
POST /dispatch          {rentalId, robots: {Picking, Packing, Delivery}}   marketplace → agent
POST /rentals/:id/meter {movesCompleted}                          agent → marketplace, per move
POST /rentals/:id/complete + /settle                             agent → marketplace, at the end
GET  /jobs/:rentalId    current reading and fault state
POST /jobs/:rentalId/abort
GET  /health            claimed robots and active job count
```

Readings are cumulative and monotonic, so a dropped or late-arriving one cannot corrupt the
fare — the next reading supersedes it. The agent reports only what the robot finished; runtime
is the marketplace's own clock, so a misconfigured agent cannot inflate a fare. If the robot faults partway through, the agent cancels
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

## The warehouse simulator

`robot-agent/robot-sim/` is the simulator, copied verbatim from `i-mwangi/HyperAgile`. World,
controllers, meshes and status files are byte-for-byte the originals — nothing renamed, moved
or rewritten:

```
robot-sim/
  webot-world-setup/factory.wbt              the floor, three robots, three tables, the crates
  robot-controllers/robot_{1,2,3}_controller/  one controller and one state.txt per robot
  robot-part-stl/                            chassis and myCobot arm meshes
  robot-status-memory/{color,order,robot}.txt  what the controllers read while they work
  connectivity-layer-server/webots.py        the scenario endpoints
```

The three robots are a myCobot arm on a mecanum base, each with a Robotiq 2F-140 gripper. Their
routes are the ones their own controllers drive: hardcoded travel, gripper close, carry, place.

The interface is `webots.py`. One endpoint per leg — `/api/scenario1`, `2`, `3` — and each does
the same thing: check the robot's `state.txt` reads `1`, write the order and robot ids into
`order.txt` and `robot.txt`, and set `state.txt` to `2`. The controller is polling that file;
seeing `2` it runs its task and writes `0` when the work is done. `scenario1` also writes
`color.txt`, which is how the picking robot is told which crate the order is for.

That maps onto Canopy's three legs directly: scenario 1 is Picking, 2 is Packing, 3 is Delivery.

A finished task calls back to a URL the source leaves as a placeholder, so the connectivity
layer watches `state.txt` return to `0` instead. That is the only completion signal there is: a
controller runs a whole leg in one call with nothing observable in between, so a leg's two moves
are credited together rather than one at a time. A controller also `break`s out of its loop when
its task is done — but Webots restarts it, it writes `1` again, and the fleet is ready for the
next order without the simulator being restarted.

The repo layout is not a runnable Webots project as it stands: `factory.wbt` refers to its
meshes as `../stls/`, and `webots.py` expects to run from a directory holding the three
controller folders alongside the status files. `assemble-sim.py` arranges them into that shape
without duplicating anything: the world, the meshes and the three controller sources are hard
links, so they are one set of bytes under two names. Only the six files the simulator writes to
are real copies — twelve bytes in all — which is what keeps a run from leaving a mark on the
vendored tree:

```bash
cd robot-agent
python assemble-sim.py                                        # builds ./sim, gitignored
webots sim/worlds/factory.wbt
cd sim/controllers && python ../../robot-sim/connectivity-layer-server/webots.py   # :5000
```

Then the connectivity layer on the scenario backend, and the API pointed at it:

```bash
cd robot-agent && ROBOT_BACKEND=scenario python connectivity-layer/app.py
cd server && ROBOT_AGENT_URL=http://localhost:5001 npm start
```

Placing an order now runs the vendored robots: roughly a minute a leg, three legs, then
settlement. `WEBOTS_PRODUCT_ID` picks which crate the order is for — 0 green, 1 blue, 2 purple —
which is what `scenario1` turns into the colour code the picking controller reads.

A leg occasionally goes missing. The simulator's controllers parse their state file with no
guard while its server rewrites that file in place, so a read landing between the two raises
and takes the controller down. Webots restarts it, it reports ready, and the leg it was holding
is gone with nothing having reported a failure. The bridge watches for that — a robot reporting
ready again after being given work has dropped it — and hands the leg over again, up to
`SCENARIO_ATTEMPTS` times. The fix belongs in the simulator, but not in a vendored copy of it.

## Stub mode

To click through the whole flow with no Circle account and nothing deployed:

```bash
cd server && STUB_MODE=true npm start   # :8080, in-memory Circle and Arc
cd web && npm run dev                   # :3000
```

The fleet is a ten-robot registry across the three classes (one per class down for maintenance,
so the grid is not uniform). In stub mode each new renter is funded with 500 USDC and transfers
settle instantly. Every other code path is the real one — the same ledger, the same pricing, the
same rental service. Only the Circle adapter is swapped.

The rental page carries an **Advance meter** button in stub mode, standing in for the robot
agent so a rental can be driven by hand.

### Real money

Without `STUB_MODE`, Circle is real and USDC actually moves between wallets:

```bash
cd server && SEED_RENTER_USDC=5 npm start
```

Each robot class is assigned a real Circle wallet at boot, so an order's three-way split lands
in three balances you can look at. `SEED_RENTER_USDC` moves a float from the operating wallet
to each new renter, which saves sending every tester to a faucet.

## Frontend

```bash
cd web
npm install
cp .env.example .env
npm run dev
```

Five screens: a landing page that opens a renter or owner account, a fleet browser with class
filters and live availability, an order modal that prices the three legs and shows the hold, a
rental page, and a wallet with a deposit address, withdrawals, and a full activity ledger.

The rental page is the one that matters, and it is a view rather than a console: the order
arrives already running. It lays the job out in panels — the three legs with the robot and owner
on each, an ordered detail log of every event with its transaction hash, a warehouse floor view
carrying the live fare and elapsed clock, and a settlement showing the fare capture, a payout
row per owner, and the platform fee.

The order modal and the rental page both make the hold explicit — the fare shown while a job
runs is what you will be charged, and the authorization is labelled as a reservation rather than
a charge, because that distinction is the thing users get wrong about metered billing.

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

Copy the printed wallet ids and addresses into `.env`, then fund the operating wallet with USDC
from the [faucet](https://faucet.circle.com/) — it seeds new renters and carries the working
float.

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
| `GET` | `/floor-plan` | The fixed route every order follows |
| `POST` | `/rentals/quote` | Price an order without reserving anything |
| `POST` | `/rentals` | Reserve a robot per leg and place the hold |
| `POST` | `/rentals/:id/meter` | Report a finished move; the sixth settles the order |
| `POST` | `/rentals/:id/complete` | Stop early and settle whatever ran |
| `POST` | `/rentals/:id/cancel` | Void the order and release the hold |
| `POST` | `/webhooks/circle` | Inbound transfer notifications become deposits |
| `POST` | `/treasury/rebalance` | Sweep to treasury or top up the operating float |
| `GET` | `/treasury/reconcile/:id` | Compare the ledger against the on-chain balance |

## Tests

```bash
npm test
```

Covers the parts where a mistake costs money: deposits are credited once per transaction id,
held funds cannot be withdrawn or double-spent, concurrent holds against one balance serialise,
every owner's share plus the fee equals the fare exactly, a fare can never exceed its
authorization, settlement is idempotent, an order that cannot reserve all three robots gives
back both the robots and the hold, and the same robot is never handed to two orders.

## Production notes

- `InMemoryLedgerStore` and `InMemoryRentalStore` are reference implementations. For real
  traffic, implement `LedgerStore` against a database with row locks and a unique index on
  `groupId` — that index is what makes deposit and settlement replay-safe. Nothing above the
  store interface changes.
- The entity secret belongs in a secrets manager or HSM, never in `.env` and never in logs.
- Calls to Circle retry transient failures — a name lookup blip, a dropped connection, a rate
  limit, a 5xx — with exponential backoff. A request Circle *rejected* is never repeated, since
  it would fail identically and bury the real cause. Transfers are safe to retry because the
  idempotency key makes a replay return the original transaction rather than send a second one.
  Startup retries harder than the request path: the marketplace waits rather than refusing to
  boot because DNS hiccuped.
- Deposits arrive through the Circle notification sink, which needs a public URL. Locally
  there isn't one, so `POST /accounts/:id/deposits/sync` reads the wallet balance and credits
  whatever the ledger cannot account for. Keep it in production as a backstop for a dropped
  webhook; it is idempotent on the observed balance.
- `InMemoryFleetRegistry` forgets the fleet on restart, and `reserve` is only atomic within one
  process. A database version needs a row lock there, or two orders can be handed the same robot.
- `POST /treasury/rebalance` and the reconcile endpoint should run on a schedule. A non-zero
  drift means USDC arrived that no ledger entry accounts for.
- The web app is served from `WEB_ORIGIN` (default `http://localhost:3000`), which is the only
  origin the API sets CORS headers for. Change it for a real deployment.
- Settlement writes the ledger before submitting transfers. If a transfer fails after the ledger
  is written, the settlement group id is a stable idempotency key, so the transfer can be retried
  against exactly one set of entries rather than re-running the capture.
