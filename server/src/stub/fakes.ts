import { randomUUID } from 'node:crypto';

import type { AppConfig } from '../config.ts';
import { toMinorUnits } from '../config.ts';
import type { ProvisionedWallet, TransferReceipt } from '../circle/client.ts';
import type { MeterReading, RateCard } from '../pricing/fare.ts';
import type { OnChainRobot, RobotClass } from '../chain/rental-chain.ts';

/**
 * In-memory stand-ins for Circle and Arc, so the whole flow can be clicked through without an
 * API key or a deployment. Enabled with STUB_MODE=true. Balances behave, transfers settle
 * instantly, and the fleet is seeded below.
 */

function address(seed: number): `0x${string}` {
  return `0x${seed.toString(16).padStart(40, '0')}` as `0x${string}`;
}

export class StubWalletGateway {
  private readonly balances = new Map<string, bigint>();
  private readonly addresses = new Map<string, `0x${string}`>();
  private readonly transactions = new Map<string, TransferReceipt>();
  private seed = 0x1000;

  /** Renters are seeded with a balance so a rental can be started immediately. */
  constructor(private readonly startingBalance = toMinorUnits('500')) {}

  async createWalletSet(): Promise<string> {
    return `stub-wallet-set-${randomUUID().slice(0, 8)}`;
  }

  async createWallets(
    _walletSetId: string,
    count: number,
    options: { accountType?: 'EOA' | 'SCA'; refId?: string } = {},
  ): Promise<ProvisionedWallet[]> {
    return Array.from({ length: count }, () => {
      const id = `stub-wallet-${randomUUID().slice(0, 8)}`;
      const walletAddress = address(this.seed++);

      this.addresses.set(id, walletAddress);
      this.balances.set(id, options.refId?.startsWith('renter:') ? this.startingBalance : 0n);

      return {
        id,
        address: walletAddress,
        blockchain: 'ARC-TESTNET',
        accountType: options.accountType ?? 'EOA',
      };
    });
  }

  async createWallet(
    walletSetId: string,
    options: { accountType?: 'EOA' | 'SCA'; refId?: string } = {},
  ): Promise<ProvisionedWallet> {
    const [wallet] = await this.createWallets(walletSetId, 1, options);
    return wallet!;
  }

  async getUsdcBalance(walletId: string): Promise<bigint> {
    return this.balances.get(walletId) ?? 0n;
  }

  async transferUsdc(params: {
    walletId: string;
    destinationAddress: `0x${string}`;
    amount: bigint;
    idempotencyKey: string;
  }): Promise<TransferReceipt> {
    const existing = this.transactions.get(params.idempotencyKey);
    if (existing) return existing;

    const from = this.balances.get(params.walletId) ?? 0n;
    this.balances.set(params.walletId, from - params.amount);

    for (const [id, walletAddress] of this.addresses) {
      if (walletAddress === params.destinationAddress) {
        this.balances.set(id, (this.balances.get(id) ?? 0n) + params.amount);
        break;
      }
    }

    const receipt: TransferReceipt = {
      transactionId: `stub-tx-${randomUUID().slice(0, 8)}`,
      state: 'COMPLETE',
      txHash: `0x${randomUUID().replace(/-/g, '')}`,
    };
    this.transactions.set(params.idempotencyKey, receipt);
    return receipt;
  }

  async executeContract(params: { idempotencyKey: string }): Promise<TransferReceipt> {
    const existing = this.transactions.get(params.idempotencyKey);
    if (existing) return existing;

    const receipt: TransferReceipt = {
      transactionId: `stub-tx-${randomUUID().slice(0, 8)}`,
      state: 'COMPLETE',
      txHash: `0x${randomUUID().replace(/-/g, '')}`,
    };
    this.transactions.set(params.idempotencyKey, receipt);
    return receipt;
  }

  async getTransaction(transactionId: string): Promise<TransferReceipt> {
    return { transactionId, state: 'COMPLETE' };
  }

  async waitForTransaction(transactionId: string): Promise<TransferReceipt> {
    return { transactionId, state: 'COMPLETE' };
  }
}

type StubRobot = OnChainRobot & { status: number };

const CLASS_RATES: Record<RobotClass, RateCard> = {
  0: {
    baseFare: toMinorUnits('2'),
    perMinute: toMinorUnits('0.35'),
    perTask: toMinorUnits('0.60'),
    minimumFare: toMinorUnits('3'),
  },
  1: {
    baseFare: toMinorUnits('1.5'),
    perMinute: toMinorUnits('0.25'),
    perTask: toMinorUnits('0.45'),
    minimumFare: toMinorUnits('2.5'),
  },
  2: {
    baseFare: toMinorUnits('3'),
    perMinute: toMinorUnits('0.5'),
    perTask: toMinorUnits('0.9'),
    minimumFare: toMinorUnits('4'),
  },
};

const STATUS_AVAILABLE = 1;
const STATUS_RENTED = 2;
const STATUS_MAINTENANCE = 3;

export class StubChain {
  private readonly robots = new Map<string, StubRobot>();
  private readonly ownerAccounts = new Map<string, string>();
  private nextRentalId = 0n;
  private readonly writes: string[] = [];

  constructor(ownerAddress: `0x${string}`) {
    const layout: { class_: RobotClass; count: number }[] = [
      { class_: 0, count: 4 },
      { class_: 1, count: 3 },
      { class_: 2, count: 3 },
    ];

    let id = 0n;
    for (const { class_, count } of layout) {
      for (let index = 0; index < count; index += 1) {
        // One unit per class starts out down for maintenance, so the grid is not uniform.
        const status = index === count - 1 && class_ !== 1 ? STATUS_MAINTENANCE : STATUS_AVAILABLE;

        this.robots.set(id.toString(), {
          id,
          owner: ownerAddress,
          class_,
          status,
          rates: CLASS_RATES[class_],
          metadataUri: `stub://robot/${id}`,
          completedRentals: Math.floor(Math.random() * 40) + 3,
        });
        id += 1n;
      }
    }
  }

  registerOwnerAccount(address: `0x${string}`, accountId: string): void {
    this.ownerAccounts.set(address.toLowerCase(), accountId);
  }

  async getRobot(robotId: bigint): Promise<OnChainRobot> {
    const robot = this.robots.get(robotId.toString());
    if (!robot) throw new Error(`Unknown robot ${robotId}`);
    return robot;
  }

  async listRobots(): Promise<OnChainRobot[]> {
    return [...this.robots.values()].sort((a, b) => Number(a.id - b.id));
  }

  async getFleetAvailability(class_: RobotClass): Promise<{ availableRobots: number; totalRobots: number }> {
    const inClass = [...this.robots.values()].filter((robot) => robot.class_ === class_);
    return {
      availableRobots: inClass.filter((robot) => robot.status === STATUS_AVAILABLE).length,
      totalRobots: inClass.length,
    };
  }

  async startRental(params: { robotId: bigint }): Promise<bigint> {
    const robot = this.robots.get(params.robotId.toString());
    if (!robot) throw new Error(`Unknown robot ${params.robotId}`);
    if (robot.status !== STATUS_AVAILABLE) throw new Error(`Robot ${params.robotId} is not available`);

    robot.status = STATUS_RENTED;
    this.writes.push(`startRental(${params.robotId})`);
    return this.nextRentalId++;
  }

  async recordMeter(rentalId: bigint, reading: MeterReading): Promise<void> {
    this.writes.push(`recordMeter(${rentalId}, ${Math.ceil(reading.meteredMinutes)})`);
  }

  async completeRental(rentalId: bigint): Promise<void> {
    this.writes.push(`completeRental(${rentalId})`);
  }

  async settleRental(rentalId: bigint, fare: bigint): Promise<void> {
    this.writes.push(`settleRental(${rentalId}, ${fare})`);
    this.releaseRobotFor(rentalId);
  }

  async cancelRental(rentalId: bigint): Promise<void> {
    this.writes.push(`cancelRental(${rentalId})`);
    this.releaseRobotFor(rentalId);
  }

  /**
   * The stub does not index rentals to robots, so it frees whichever unit is rented. That is
   * sufficient for a single-user walkthrough and keeps the stub free of bookkeeping the real
   * contract already does.
   */
  private releaseRobotFor(_rentalId: bigint): void {
    for (const robot of this.robots.values()) {
      if (robot.status === STATUS_RENTED) {
        robot.status = STATUS_AVAILABLE;
        return;
      }
    }
  }
}

export function stubConfig(): AppConfig {
  return {
    circle: {
      apiKey: 'stub',
      entitySecret: 'stub',
      walletSetName: 'stub-robot-marketplace',
    },
    chain: {
      blockchain: 'ARC-TESTNET',
      rpcUrl: 'stub',
      usdcTokenId: 'stub-usdc',
      robotRegistryAddress: address(1),
      rentalManagerAddress: address(2),
      settlementOperatorWalletId: 'stub-operator',
    },
    marketplace: {
      platformFeeBps: Number(process.env.PLATFORM_FEE_BPS ?? 1500),
      authorizationBufferBps: Number(process.env.AUTHORIZATION_BUFFER_BPS ?? 13000),
      operatingFloatCeiling: toMinorUnits('25000'),
      operatingFloatFloor: toMinorUnits('5000'),
      minimumDeposit: toMinorUnits('1'),
      minimumWithdrawal: toMinorUnits('5'),
    },
    server: { port: Number(process.env.PORT ?? 8080) },
  };
}

/** Every stub robot belongs to this owner, so earnings land in one place. */
export const STUB_OWNER_ADDRESS = address(0xfeed);
