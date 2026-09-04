import { randomUUID } from 'node:crypto';

import {
  InsufficientFunds,
  LedgerConflict,
  type Account,
  type AccountRole,
  type Hold,
  type LedgerEntry,
  type EntryKind,
  type PayoutMode,
} from './types.ts';

export interface LedgerStore {
  getAccount(accountId: string): Promise<Account | undefined>;
  putAccount(account: Account): Promise<void>;
  listAccountsByRole(role: AccountRole): Promise<Account[]>;
  getHold(holdId: string): Promise<Hold | undefined>;
  putHold(hold: Hold): Promise<void>;
  findOpenHoldForRental(rentalId: string): Promise<Hold | undefined>;
  appendEntries(entries: LedgerEntry[]): Promise<void>;
  listEntries(filter: { accountId?: string; rentalId?: string; groupId?: string }): Promise<LedgerEntry[]>;
  hasGroup(groupId: string): Promise<boolean>;
  /** Runs `fn` with exclusive access to the named resources. */
  transaction<T>(keys: string[], fn: () => Promise<T>): Promise<T>;
}

type PostingDraft = {
  kind: EntryKind;
  accountId: string;
  amount: bigint;
  heldDelta?: bigint;
  rentalId?: string;
  transactionId?: string;
  memo?: string;
};

/**
 * Balance authority for the marketplace. Every movement of value is an entry here first;
 * on-chain transfers reference the entry group that authorised them.
 */
export class Ledger {
  constructor(private readonly store: LedgerStore) {}

  async openAccount(params: {
    role: AccountRole;
    walletId: string;
    address: `0x${string}`;
    accountId?: string;
    payoutMode?: PayoutMode;
  }): Promise<Account> {
    const account: Account = {
      id: params.accountId ?? randomUUID(),
      role: params.role,
      walletId: params.walletId,
      address: params.address,
      payoutMode: params.payoutMode ?? 'custodial',
      available: 0n,
      held: 0n,
      createdAt: Date.now(),
    };

    await this.store.putAccount(account);
    return account;
  }

  async requireAccount(accountId: string): Promise<Account> {
    const account = await this.store.getAccount(accountId);
    if (!account) throw new LedgerConflict(`Unknown account ${accountId}`);
    return account;
  }

  async balanceOf(accountId: string): Promise<{ available: bigint; held: bigint; total: bigint }> {
    const account = await this.requireAccount(accountId);
    return { available: account.available, held: account.held, total: account.available + account.held };
  }

  /**
   * Credits an account for funds that have landed on-chain. Idempotent on `groupId`, so a
   * replayed deposit notification cannot double-credit.
   */
  async recordDeposit(params: {
    accountId: string;
    amount: bigint;
    groupId: string;
    transactionId: string;
  }): Promise<void> {
    if (params.amount <= 0n) throw new LedgerConflict('Deposit amount must be positive');

    await this.store.transaction([params.accountId, params.groupId], async () => {
      if (await this.store.hasGroup(params.groupId)) return;

      await this.post(params.groupId, [
        {
          kind: 'deposit',
          accountId: params.accountId,
          amount: params.amount,
          transactionId: params.transactionId,
          memo: 'on-chain deposit',
        },
      ]);
    });
  }

  /** Reserves funds against an account for the duration of a rental. */
  async placeHold(params: {
    accountId: string;
    rentalId: string;
    amount: bigint;
    groupId: string;
  }): Promise<Hold> {
    if (params.amount <= 0n) throw new LedgerConflict('Hold amount must be positive');

    return this.store.transaction([params.accountId, params.rentalId], async () => {
      const existing = await this.store.findOpenHoldForRental(params.rentalId);
      if (existing) throw new LedgerConflict(`Rental ${params.rentalId} already has an open hold`);

      const account = await this.requireAccount(params.accountId);
      if (account.available < params.amount) {
        throw new InsufficientFunds(account.id, params.amount, account.available);
      }

      const hold: Hold = {
        id: randomUUID(),
        accountId: params.accountId,
        rentalId: params.rentalId,
        amount: params.amount,
        capturedAmount: 0n,
        status: 'open',
        createdAt: Date.now(),
      };

      await this.store.putHold(hold);
      await this.post(params.groupId, [
        {
          kind: 'hold',
          accountId: params.accountId,
          amount: 0n,
          heldDelta: params.amount,
          rentalId: params.rentalId,
          memo: `authorization hold ${hold.id}`,
        },
      ]);

      return hold;
    });
  }

  /**
   * Captures the final fare from an open hold and splits it between the robot owner and
   * the platform revenue account. Any unused authorization returns to the renter.
   */
  async captureAndSplit(params: {
    holdId: string;
    fare: bigint;
    platformFee: bigint;
    ownerAccountId: string;
    revenueAccountId: string;
    groupId: string;
  }): Promise<{ hold: Hold; ownerPayout: bigint; released: bigint }> {
    if (params.fare < 0n) throw new LedgerConflict('Fare cannot be negative');
    if (params.platformFee < 0n || params.platformFee > params.fare) {
      throw new LedgerConflict('Platform fee must fall between zero and the fare');
    }

    const hold = await this.store.getHold(params.holdId);
    if (!hold) throw new LedgerConflict(`Unknown hold ${params.holdId}`);

    return this.store.transaction(
      [hold.accountId, params.ownerAccountId, params.revenueAccountId, params.groupId],
      async () => {
        const current = await this.store.getHold(params.holdId);
        if (!current) throw new LedgerConflict(`Unknown hold ${params.holdId}`);
        if (current.status !== 'open') throw new LedgerConflict(`Hold ${params.holdId} is ${current.status}`);
        if (params.fare > current.amount) {
          throw new LedgerConflict(`Fare ${params.fare} exceeds authorization ${current.amount}`);
        }

        const ownerPayout = params.fare - params.platformFee;
        const released = current.amount - params.fare;

        const postings: PostingDraft[] = [
          {
            kind: 'capture',
            accountId: current.accountId,
            amount: -params.fare,
            heldDelta: -current.amount,
            rentalId: current.rentalId,
            memo: `captured fare for rental ${current.rentalId}`,
          },
        ];

        if (released > 0n) {
          postings.push({
            kind: 'hold_release',
            accountId: current.accountId,
            amount: 0n,
            rentalId: current.rentalId,
            memo: `released unused authorization for rental ${current.rentalId}`,
          });
        }

        if (ownerPayout > 0n) {
          postings.push({
            kind: 'payout',
            accountId: params.ownerAccountId,
            amount: ownerPayout,
            rentalId: current.rentalId,
            memo: `owner earnings for rental ${current.rentalId}`,
          });
        }

        if (params.platformFee > 0n) {
          postings.push({
            kind: 'platform_fee',
            accountId: params.revenueAccountId,
            amount: params.platformFee,
            rentalId: current.rentalId,
            memo: `platform fee for rental ${current.rentalId}`,
          });
        }

        await this.post(params.groupId, postings);

        const settled: Hold = {
          ...current,
          status: 'captured',
          capturedAmount: params.fare,
          resolvedAt: Date.now(),
        };
        await this.store.putHold(settled);

        return { hold: settled, ownerPayout, released };
      },
    );
  }

  /** Voids a hold without capturing anything. */
  async releaseHold(params: { holdId: string; groupId: string; reason: string }): Promise<Hold> {
    const hold = await this.store.getHold(params.holdId);
    if (!hold) throw new LedgerConflict(`Unknown hold ${params.holdId}`);

    return this.store.transaction([hold.accountId, params.groupId], async () => {
      const current = await this.store.getHold(params.holdId);
      if (!current) throw new LedgerConflict(`Unknown hold ${params.holdId}`);
      if (current.status !== 'open') return current;

      await this.post(params.groupId, [
        {
          kind: 'hold_release',
          accountId: current.accountId,
          amount: 0n,
          heldDelta: -current.amount,
          rentalId: current.rentalId,
          memo: params.reason,
        },
      ]);

      const voided: Hold = { ...current, status: 'voided', resolvedAt: Date.now() };
      await this.store.putHold(voided);
      return voided;
    });
  }

  /** Debits an account for a payout leaving the marketplace. */
  async recordWithdrawal(params: {
    accountId: string;
    amount: bigint;
    groupId: string;
    transactionId?: string;
    destination: string;
  }): Promise<void> {
    if (params.amount <= 0n) throw new LedgerConflict('Withdrawal amount must be positive');

    await this.store.transaction([params.accountId, params.groupId], async () => {
      if (await this.store.hasGroup(params.groupId)) return;

      const account = await this.requireAccount(params.accountId);
      if (account.available < params.amount) {
        throw new InsufficientFunds(account.id, params.amount, account.available);
      }

      await this.post(params.groupId, [
        {
          kind: 'withdrawal',
          accountId: params.accountId,
          amount: -params.amount,
          transactionId: params.transactionId,
          memo: `withdrawal to ${params.destination}`,
        },
      ]);
    });
  }

  /** Records an internal move between two platform accounts. */
  async recordInternalMove(params: {
    fromAccountId: string;
    toAccountId: string;
    amount: bigint;
    kind: Extract<EntryKind, 'sweep' | 'topup'>;
    groupId: string;
    transactionId?: string;
  }): Promise<void> {
    if (params.amount <= 0n) throw new LedgerConflict('Internal move amount must be positive');

    await this.store.transaction([params.fromAccountId, params.toAccountId, params.groupId], async () => {
      if (await this.store.hasGroup(params.groupId)) return;

      const from = await this.requireAccount(params.fromAccountId);
      if (from.available < params.amount) {
        throw new InsufficientFunds(from.id, params.amount, from.available);
      }

      await this.post(params.groupId, [
        {
          kind: params.kind,
          accountId: params.fromAccountId,
          amount: -params.amount,
          transactionId: params.transactionId,
        },
        {
          kind: params.kind,
          accountId: params.toAccountId,
          amount: params.amount,
          transactionId: params.transactionId,
        },
      ]);
    });
  }

  async statement(filter: { accountId?: string; rentalId?: string }): Promise<LedgerEntry[]> {
    return this.store.listEntries(filter);
  }

  private async post(groupId: string, drafts: PostingDraft[]): Promise<void> {
    const now = Date.now();
    const entries: LedgerEntry[] = [];
    const touched = new Map<string, Account>();

    for (const draft of drafts) {
      const account = touched.get(draft.accountId) ?? (await this.requireAccount(draft.accountId));
      const heldDelta = draft.heldDelta ?? 0n;

      const nextHeld = account.held + heldDelta;
      const nextAvailable = account.available + draft.amount - heldDelta;

      if (nextHeld < 0n) throw new LedgerConflict(`Held balance for ${account.id} would go negative`);
      if (nextAvailable < 0n) throw new InsufficientFunds(account.id, -draft.amount, account.available);

      touched.set(account.id, { ...account, held: nextHeld, available: nextAvailable });

      entries.push({
        id: randomUUID(),
        kind: draft.kind,
        accountId: draft.accountId,
        amount: draft.amount,
        heldDelta,
        groupId,
        rentalId: draft.rentalId,
        transactionId: draft.transactionId,
        memo: draft.memo,
        createdAt: now,
      });
    }

    for (const account of touched.values()) {
      await this.store.putAccount(account);
    }
    await this.store.appendEntries(entries);
  }
}
