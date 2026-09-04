import type { LedgerStore } from './ledger.ts';
import type { Account, AccountRole, Hold, LedgerEntry } from './types.ts';

/**
 * Reference store. Balances live in memory and locking is cooperative, which is enough for a
 * single process. Swapping in a database means implementing `LedgerStore` with row locks and
 * a unique index on `groupId`; nothing else in the service changes.
 */
export class InMemoryLedgerStore implements LedgerStore {
  private readonly accounts = new Map<string, Account>();
  private readonly holds = new Map<string, Hold>();
  private readonly entries: LedgerEntry[] = [];
  private readonly groups = new Set<string>();
  private readonly locks = new Map<string, Promise<unknown>>();

  async getAccount(accountId: string): Promise<Account | undefined> {
    return this.accounts.get(accountId);
  }

  async putAccount(account: Account): Promise<void> {
    this.accounts.set(account.id, account);
  }

  async listAccountsByRole(role: AccountRole): Promise<Account[]> {
    return [...this.accounts.values()].filter((account) => account.role === role);
  }

  async getHold(holdId: string): Promise<Hold | undefined> {
    return this.holds.get(holdId);
  }

  async putHold(hold: Hold): Promise<void> {
    this.holds.set(hold.id, hold);
  }

  async findOpenHoldForRental(rentalId: string): Promise<Hold | undefined> {
    return [...this.holds.values()].find((hold) => hold.rentalId === rentalId && hold.status === 'open');
  }

  async appendEntries(entries: LedgerEntry[]): Promise<void> {
    for (const entry of entries) {
      this.entries.push(entry);
      this.groups.add(entry.groupId);
    }
  }

  async listEntries(filter: {
    accountId?: string;
    rentalId?: string;
    groupId?: string;
  }): Promise<LedgerEntry[]> {
    return this.entries.filter(
      (entry) =>
        (filter.accountId === undefined || entry.accountId === filter.accountId) &&
        (filter.rentalId === undefined || entry.rentalId === filter.rentalId) &&
        (filter.groupId === undefined || entry.groupId === filter.groupId),
    );
  }

  async hasGroup(groupId: string): Promise<boolean> {
    return this.groups.has(groupId);
  }

  async transaction<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort();
    const previous = ordered.map((key) => this.locks.get(key) ?? Promise.resolve());

    // The lock must be registered in the same tick it is read, or two callers that arrive
    // together both observe a free key and run concurrently.
    const run = Promise.allSettled(previous).then(() => fn());
    const guard = run.then(
      () => undefined,
      () => undefined,
    );
    for (const key of ordered) {
      this.locks.set(key, guard);
    }

    try {
      return await run;
    } finally {
      for (const key of ordered) {
        if (this.locks.get(key) === guard) this.locks.delete(key);
      }
    }
  }
}
