import { randomUUID } from 'node:crypto';

import type { AppConfig } from '../config.ts';
import type { CircleWalletGateway } from '../circle/client.ts';
import type { Ledger } from '../ledger/ledger.ts';
import { LedgerConflict, type Account } from '../ledger/types.ts';
import type { AccountDirectory } from './service.ts';

export type OnboardResult = {
  account: Account;
  depositAddress: `0x${string}`;
};

/**
 * Provisions the wallet behind each marketplace participant and moves value in and out of
 * the platform. Renters deposit to an address the platform controls; owners withdraw from
 * their earnings balance to an address they nominate.
 */
export class AccountService {
  constructor(
    private readonly config: AppConfig,
    private readonly wallets: CircleWalletGateway,
    private readonly ledger: Ledger,
    private readonly directory: AccountDirectory,
    private readonly walletSetId: string,
  ) {}

  async onboardRenter(): Promise<OnboardResult> {
    const accountId = randomUUID();
    const wallet = await this.wallets.createWallet(this.walletSetId, {
      accountType: 'SCA',
      refId: `renter:${accountId}`,
    });

    const account = await this.ledger.openAccount({
      accountId,
      role: 'renter',
      walletId: wallet.id,
      address: wallet.address,
    });

    return { account, depositAddress: wallet.address };
  }

  async onboardOwner(): Promise<OnboardResult> {
    const accountId = randomUUID();
    const wallet = await this.wallets.createWallet(this.walletSetId, {
      accountType: 'SCA',
      refId: `owner:${accountId}`,
    });

    const account = await this.ledger.openAccount({
      accountId,
      role: 'owner',
      walletId: wallet.id,
      address: wallet.address,
    });

    await this.directory.registerOwner(wallet.address, account.id);
    return { account, depositAddress: wallet.address };
  }

  /**
   * Credits a confirmed inbound transfer. Called from the Circle notification handler, and
   * safe to replay: the transaction id is the idempotency key.
   */
  async creditDeposit(params: { accountId: string; amount: bigint; transactionId: string }): Promise<void> {
    if (params.amount < this.config.marketplace.minimumDeposit) {
      throw new LedgerConflict(
        `Deposit below the ${this.config.marketplace.minimumDeposit} minimum was ignored`,
      );
    }

    await this.ledger.recordDeposit({
      accountId: params.accountId,
      amount: params.amount,
      groupId: `deposit:${params.transactionId}`,
      transactionId: params.transactionId,
    });
  }

  /**
   * Pays out an account balance to an address the user nominates. The ledger is debited
   * first so a concurrent request cannot spend the same balance twice.
   */
  async withdraw(params: {
    accountId: string;
    amount: bigint;
    destinationAddress: `0x${string}`;
  }): Promise<{ transactionId: string; amount: bigint }> {
    if (params.amount < this.config.marketplace.minimumWithdrawal) {
      throw new LedgerConflict(
        `Withdrawal must be at least ${this.config.marketplace.minimumWithdrawal}`,
      );
    }

    const account = await this.ledger.requireAccount(params.accountId);
    const groupId = `withdrawal:${randomUUID()}`;

    await this.ledger.recordWithdrawal({
      accountId: account.id,
      amount: params.amount,
      groupId,
      destination: params.destinationAddress,
    });

    try {
      const receipt = await this.wallets.transferUsdc({
        walletId: account.walletId,
        destinationAddress: params.destinationAddress,
        amount: params.amount,
        idempotencyKey: groupId,
      });

      return { transactionId: receipt.transactionId, amount: params.amount };
    } catch (error) {
      await this.ledger.recordDeposit({
        accountId: account.id,
        amount: params.amount,
        groupId: `${groupId}:reversal`,
        transactionId: `${groupId}:reversal`,
      });
      throw error;
    }
  }

  async balance(accountId: string) {
    return this.ledger.balanceOf(accountId);
  }
}
