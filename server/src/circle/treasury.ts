import { randomUUID } from 'node:crypto';

import type { AppConfig } from '../config.ts';
import type { CircleWalletGateway } from './client.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { PlatformAccounts } from '../rental/service.ts';

export type SweepResult = {
  action: 'sweep' | 'topup' | 'none';
  amount: bigint;
  transactionId?: string;
};

/**
 * Keeps the hot operating wallet inside its float band. Balance above the ceiling moves to
 * the cold treasury wallet; balance below the floor is topped back up. Nothing on the request
 * path touches the treasury wallet directly.
 */
export class TreasuryManager {
  constructor(
    private readonly config: AppConfig,
    private readonly wallets: CircleWalletGateway,
    private readonly ledger: Ledger,
    private readonly platform: PlatformAccounts,
  ) {}

  async rebalance(): Promise<SweepResult> {
    const operating = await this.ledger.requireAccount(this.platform.operatingAccountId);
    const treasury = await this.ledger.requireAccount(this.platform.treasuryAccountId);
    const { operatingFloatCeiling, operatingFloatFloor } = this.config.marketplace;

    if (operating.available > operatingFloatCeiling) {
      const amount = operating.available - operatingFloatCeiling;
      const groupId = `sweep:${randomUUID()}`;

      const receipt = await this.wallets.transferUsdc({
        walletId: operating.walletId,
        destinationAddress: treasury.address,
        amount,
        idempotencyKey: groupId,
      });

      await this.ledger.recordInternalMove({
        fromAccountId: operating.id,
        toAccountId: treasury.id,
        amount,
        kind: 'sweep',
        groupId,
        transactionId: receipt.transactionId,
      });

      return { action: 'sweep', amount, transactionId: receipt.transactionId };
    }

    if (operating.available < operatingFloatFloor) {
      const shortfall = operatingFloatFloor - operating.available;
      const amount = shortfall > treasury.available ? treasury.available : shortfall;
      if (amount <= 0n) return { action: 'none', amount: 0n };

      const groupId = `topup:${randomUUID()}`;
      const receipt = await this.wallets.transferUsdc({
        walletId: treasury.walletId,
        destinationAddress: operating.address,
        amount,
        idempotencyKey: groupId,
      });

      await this.ledger.recordInternalMove({
        fromAccountId: treasury.id,
        toAccountId: operating.id,
        amount,
        kind: 'topup',
        groupId,
        transactionId: receipt.transactionId,
      });

      return { action: 'topup', amount, transactionId: receipt.transactionId };
    }

    return { action: 'none', amount: 0n };
  }

  /**
   * Reconciles a ledger account against the on-chain balance of its wallet. A drift here
   * means a transfer landed that no ledger entry accounts for.
   */
  async reconcile(accountId: string): Promise<{ ledger: bigint; onChain: bigint; drift: bigint }> {
    const account = await this.ledger.requireAccount(accountId);
    const onChain = await this.wallets.getUsdcBalance(account.walletId);
    const ledgerTotal = account.available + account.held;

    return { ledger: ledgerTotal, onChain, drift: onChain - ledgerTotal };
  }
}
