import { randomUUID } from 'node:crypto';

import type { AppConfig } from '../config.ts';
import { toMinorUnits } from '../config.ts';
import type { ProvisionedWallet, TransferReceipt } from './client.ts';

/**
 * In-memory stand-in for Circle, so the whole flow can be walked through without an API key.
 * Enabled with STUB_MODE=true. Balances behave and transfers settle instantly.
 */

function address(seed: number): `0x${string}` {
  return `0x${seed.toString(16).padStart(40, '0')}` as `0x${string}`;
}

export class StubWalletGateway {
  private readonly balances = new Map<string, bigint>();
  private readonly addresses = new Map<string, `0x${string}`>();
  private readonly transactions = new Map<string, TransferReceipt>();
  private seed = 0x1000;

  /** Renters are seeded with a balance so an order can be placed immediately. */
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

  async findWalletByAddress(walletAddress: `0x${string}`): Promise<ProvisionedWallet | undefined> {
    for (const [id, known] of this.addresses) {
      if (known.toLowerCase() === walletAddress.toLowerCase()) {
        return { id, address: known, blockchain: 'ARC-TESTNET', accountType: 'EOA' };
      }
    }
    return undefined;
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

    this.balances.set(params.walletId, (this.balances.get(params.walletId) ?? 0n) - params.amount);

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

  async getTransaction(transactionId: string): Promise<TransferReceipt> {
    return { transactionId, state: 'COMPLETE' };
  }

  async waitForTransaction(transactionId: string): Promise<TransferReceipt> {
    return { transactionId, state: 'COMPLETE' };
  }
}

/** Every stub robot belongs to this owner unless a real one is registered. */
export const STUB_OWNER_ADDRESS = address(0xfeed);

export function stubConfig(): AppConfig {
  return {
    circle: { apiKey: 'stub', entitySecret: 'stub', walletSetName: 'stub-canopy' },
    chain: { blockchain: 'ARC-TESTNET', usdcTokenId: 'stub-usdc' },
    marketplace: {
      platformFeeBps: Number(process.env.PLATFORM_FEE_BPS ?? 1500),
      authorizationBufferBps: Number(process.env.AUTHORIZATION_BUFFER_BPS ?? 13000),
      operatingFloatCeiling: toMinorUnits('25000'),
      operatingFloatFloor: toMinorUnits('5000'),
      minimumDeposit: toMinorUnits('1'),
      minimumWithdrawal: toMinorUnits('5'),
      maxBillableMinutes: Number(process.env.MAX_BILLABLE_MINUTES ?? 2),
    },
    server: { port: Number(process.env.PORT ?? 8080) },
  };
}
