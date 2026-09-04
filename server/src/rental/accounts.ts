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
      accountType: 'EOA',
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

  /**
   * Registers an owner who already controls the address their robots are listed under, such
   * as the account that signed the fleet seed. No wallet is created: settlement pays them
   * directly at that address, and there is nothing for them to withdraw.
   */
  async linkOwner(address: `0x${string}`): Promise<Account> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new LedgerConflict(`Not a valid address: ${address}`);
    }

    const existing = await this.directory.ownerAccountIdFor(address);
    if (existing) return this.ledger.requireAccount(existing);

    const account = await this.ledger.openAccount({
      role: 'owner',
      walletId: '',
      address,
      payoutMode: 'direct',
    });

    await this.directory.registerOwner(address, account.id);
    return account;
  }

  async onboardOwner(): Promise<OnboardResult> {
    const accountId = randomUUID();
    const wallet = await this.wallets.createWallet(this.walletSetId, {
      accountType: 'EOA',
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
    if (account.payoutMode === 'direct') {
      throw new LedgerConflict(
        'This owner is paid directly at settlement; the platform holds no balance to withdraw',
      );
    }

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

  /**
   * Moves a float from the operating wallet into a renter account. A real on-chain transfer,
   * so the renter's balance is backed by USDC they can actually spend. Intended for testnet,
   * where sending every new renter to a faucet is friction with no value.
   */
  async fundFromOperating(params: {
    accountId: string;
    operatingAccountId: string;
    amount: bigint;
  }): Promise<void> {
    const operating = await this.ledger.requireAccount(params.operatingAccountId);
    const renter = await this.ledger.requireAccount(params.accountId);

    const available = await this.wallets.getUsdcBalance(operating.walletId);
    if (available < params.amount) {
      console.warn(
        `Operating wallet holds ${available} but ${params.amount} was requested; skipping renter seed`,
      );
      return;
    }

    const receipt = await this.wallets.transferUsdc({
      walletId: operating.walletId,
      destinationAddress: renter.address,
      amount: params.amount,
      idempotencyKey: `seed:${renter.id}`,
    });

    await this.wallets.waitForTransaction(receipt.transactionId);
    await this.ledger.recordDeposit({
      accountId: renter.id,
      amount: params.amount,
      groupId: `deposit:${receipt.transactionId}`,
      transactionId: receipt.transactionId,
    });
  }

  /**
   * Rebinds a renter account to a wallet the marketplace already controls.
   *
   * The reference ledger lives in memory, so a restart forgets which account owned which
   * wallet while the wallet itself persists at Circle. This adopts one back and credits
   * whatever it holds, rather than stranding the balance behind a forgotten account id.
   */
  async adoptRenter(address: `0x${string}`): Promise<OnboardResult> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new LedgerConflict(`Not a valid address: ${address}`);
    }

    const wallet = await this.wallets.findWalletByAddress(address);
    if (!wallet) throw new LedgerConflict(`No wallet under this account has address ${address}`);

    const account = await this.ledger.openAccount({
      role: 'renter',
      walletId: wallet.id,
      address: wallet.address,
    });

    await this.syncDeposits(account.id);
    return { account: await this.ledger.requireAccount(account.id), depositAddress: wallet.address };
  }

  /**
   * Credits USDC that arrived on chain but that no ledger entry accounts for.
   *
   * Deposits normally arrive through the Circle notification sink. This is the backstop for
   * when that has not run — a local environment with no public URL, or a dropped webhook.
   * The group id is keyed on the observed balance, so calling it repeatedly credits once.
   */
  async syncDeposits(accountId: string): Promise<{ credited: bigint; onChain: bigint }> {
    const account = await this.ledger.requireAccount(accountId);

    if (account.payoutMode === 'direct') {
      // Their wallet is their own; its balance is not the platform's to credit.
      return { credited: 0n, onChain: 0n };
    }

    const onChain = await this.wallets.getUsdcBalance(account.walletId);
    const recorded = account.available + account.held;
    const drift = onChain - recorded;

    // A negative drift is normal: the wallet pays its own gas, so it sits slightly below the
    // ledger after every outgoing transfer. Only unexplained credit is a deposit.
    if (drift <= 0n) return { credited: 0n, onChain };

    await this.ledger.recordDeposit({
      accountId,
      amount: drift,
      groupId: `deposit:sync:${accountId}:${onChain}`,
      transactionId: `sync:${accountId}:${onChain}`,
    });

    return { credited: drift, onChain };
  }

  async balance(accountId: string) {
    return this.ledger.balanceOf(accountId);
  }
}
