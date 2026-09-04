import { createHash } from 'node:crypto';

import {
  initiateDeveloperControlledWalletsClient,
  type Blockchain,
} from '@circle-fin/developer-controlled-wallets';

import type { AppConfig } from '../config.ts';
import { parseReportedAmount, toDecimalString } from '../config.ts';

export type CircleClient = ReturnType<typeof initiateDeveloperControlledWalletsClient>;

export type WalletRole = 'treasury' | 'operating' | 'revenue' | 'renter' | 'owner';

export type ProvisionedWallet = {
  id: string;
  address: `0x${string}`;
  blockchain: string;
  accountType: 'EOA' | 'SCA';
};

export type TransferReceipt = {
  transactionId: string;
  state: string;
  txHash?: string;
};

/**
 * USDC is the native gas token on Arc and every wallet here holds USDC, so a plain
 * key-controlled account covers the whole flow. Smart contract accounts exist for gas
 * sponsorship and batch execution, which would add a per-wallet deployment and a paymaster
 * this design has no use for.
 */
const DEFAULT_ACCOUNT_TYPE = 'EOA' as const;

/** Fixed namespace so the same semantic key always derives the same UUID. */
const IDEMPOTENCY_NAMESPACE = Buffer.from('1b671a64-40d5-491e-99b0-da01ff1f3341'.replace(/-/g, ''), 'hex');

/**
 * Circle requires an idempotency key in UUID format, but the keys that carry meaning here are
 * strings like `settle:<rentalId>:payout`. Deriving a version 5 UUID from the semantic key
 * keeps a retry idempotent while satisfying the format.
 */
export function idempotencyUuid(seed: string): string {
  const hash = createHash('sha1').update(IDEMPOTENCY_NAMESPACE).update(seed).digest();

  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;

  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const TERMINAL_STATES = new Set(['COMPLETE', 'CONFIRMED', 'FAILED', 'CANCELLED', 'DENIED']);
const SUCCESS_STATES = new Set(['COMPLETE', 'CONFIRMED']);

export class CircleWalletGateway {
  private readonly client: CircleClient;

  constructor(
    private readonly config: AppConfig,
    client?: CircleClient,
  ) {
    this.client =
      client ??
      initiateDeveloperControlledWalletsClient({
        apiKey: config.circle.apiKey,
        entitySecret: config.circle.entitySecret,
      });
  }

  /** Creates the wallet set that scopes every wallet the marketplace controls. */
  async createWalletSet(name = this.config.circle.walletSetName): Promise<string> {
    const response = await this.client.createWalletSet({ name });
    const walletSetId = response.data?.walletSet?.id;
    if (!walletSetId) throw new Error('Circle did not return a wallet set id');
    return walletSetId;
  }

  /**
   * Provisions wallets inside a set. Platform wallets and per-account wallets are
   * identical primitives; only their bookkeeping role differs.
   */
  async createWallets(
    walletSetId: string,
    count: number,
    options: { accountType?: 'EOA' | 'SCA'; refId?: string } = {},
  ): Promise<ProvisionedWallet[]> {
    const response = await this.client.createWallets({
      walletSetId,
      blockchains: [this.config.chain.blockchain as Blockchain],
      count,
      accountType: options.accountType ?? DEFAULT_ACCOUNT_TYPE,
      ...(options.refId ? { refId: options.refId } : {}),
    });

    const wallets = response.data?.wallets ?? [];
    if (wallets.length !== count) {
      throw new Error(`Expected ${count} wallets from Circle, received ${wallets.length}`);
    }

    const accountType = options.accountType ?? DEFAULT_ACCOUNT_TYPE;
    return wallets.map((wallet) => ({
      id: wallet.id,
      address: wallet.address as `0x${string}`,
      blockchain: wallet.blockchain,
      accountType,
    }));
  }

  async createWallet(
    walletSetId: string,
    options: { accountType?: 'EOA' | 'SCA'; refId?: string } = {},
  ): Promise<ProvisionedWallet> {
    const [wallet] = await this.createWallets(walletSetId, 1, options);
    if (!wallet) throw new Error('Circle did not return a wallet');
    return wallet;
  }

  /** On-chain USDC balance for a wallet, in minor units. */
  async getUsdcBalance(walletId: string): Promise<bigint> {
    const response = await this.client.getWalletTokenBalance({ id: walletId, includeAll: true });

    const balances = response.data?.tokenBalances ?? [];
    const usdc = balances.find((balance) => balance.token?.id === this.config.chain.usdcTokenId);
    if (!usdc?.amount) return 0n;

    return parseReportedAmount(usdc.amount);
  }

  /** Moves USDC from a wallet the marketplace controls to any address. */
  async transferUsdc(params: {
    walletId: string;
    destinationAddress: `0x${string}`;
    amount: bigint;
    idempotencyKey: string;
    refId?: string;
  }): Promise<TransferReceipt> {
    if (params.amount <= 0n) throw new Error('Transfer amount must be positive');

    const response = await this.client.createTransaction({
      walletId: params.walletId,
      tokenId: this.config.chain.usdcTokenId,
      destinationAddress: params.destinationAddress,
      amount: [toDecimalString(params.amount)],
      idempotencyKey: idempotencyUuid(params.idempotencyKey),
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      ...(params.refId ? { refId: params.refId } : {}),
    });

    const transaction = response.data;
    if (!transaction?.id) throw new Error('Circle did not return a transaction id');

    return { transactionId: transaction.id, state: transaction.state ?? 'INITIATED' };
  }

  /** Submits a contract call from a wallet the marketplace controls. */
  async executeContract(params: {
    walletId: string;
    contractAddress: `0x${string}`;
    abiFunctionSignature: string;
    abiParameters: unknown[];
    idempotencyKey: string;
  }): Promise<TransferReceipt> {
    const response = await this.client.createContractExecutionTransaction({
      walletId: params.walletId,
      contractAddress: params.contractAddress,
      abiFunctionSignature: params.abiFunctionSignature,
      abiParameters: params.abiParameters as never,
      idempotencyKey: idempotencyUuid(params.idempotencyKey),
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });

    const transaction = response.data;
    if (!transaction?.id) throw new Error('Circle did not return a transaction id');

    return { transactionId: transaction.id, state: transaction.state ?? 'INITIATED' };
  }

  async getTransaction(transactionId: string): Promise<TransferReceipt> {
    const response = await this.client.getTransaction({ id: transactionId });
    const transaction = response.data?.transaction;
    if (!transaction) throw new Error(`Unknown transaction ${transactionId}`);

    return {
      transactionId: transaction.id,
      state: transaction.state ?? 'UNKNOWN',
      txHash: transaction.txHash ?? undefined,
    };
  }

  /**
   * Blocks until a transaction reaches a terminal state. Settlement writes the ledger
   * before this resolves, so a slow confirmation never blocks the meter.
   */
  async waitForTransaction(
    transactionId: string,
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<TransferReceipt> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const intervalMs = options.intervalMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const receipt = await this.getTransaction(transactionId);
      if (TERMINAL_STATES.has(receipt.state)) {
        if (!SUCCESS_STATES.has(receipt.state)) {
          throw new Error(`Transaction ${transactionId} finished in state ${receipt.state}`);
        }
        return receipt;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for transaction ${transactionId}`);
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
