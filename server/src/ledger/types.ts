export type AccountRole = 'renter' | 'owner' | 'treasury' | 'operating' | 'revenue';

/**
 * How an owner takes their earnings.
 *
 * `custodial` owners bank with the platform: a Circle wallet holds the balance and they
 * withdraw when they choose. `direct` owners are paid straight to an address they already
 * control at settlement, so the platform never holds their money and there is nothing to
 * withdraw.
 */
export type PayoutMode = 'custodial' | 'direct';

export type Account = {
  id: string;
  role: AccountRole;
  /** Circle wallet id backing this account. Empty for a direct-payout owner. */
  walletId: string;
  address: `0x${string}`;
  payoutMode: PayoutMode;
  /** Funds the account may spend right now. */
  available: bigint;
  /** Funds reserved by an open authorization and not yet captured. */
  held: bigint;
  createdAt: number;
};

export type EntryKind =
  | 'deposit'
  | 'hold'
  | 'hold_release'
  | 'capture'
  | 'payout'
  | 'platform_fee'
  | 'withdrawal'
  | 'sweep'
  | 'topup'
  | 'adjustment';

export type LedgerEntry = {
  id: string;
  kind: EntryKind;
  accountId: string;
  /** Positive credits the account, negative debits it. */
  amount: bigint;
  /** Movement between the available and held buckets, independent of `amount`. */
  heldDelta: bigint;
  /** Groups the entries that make up one logical operation. */
  groupId: string;
  rentalId?: string;
  transactionId?: string;
  memo?: string;
  createdAt: number;
};

export type HoldStatus = 'open' | 'captured' | 'released' | 'voided';

export type Hold = {
  id: string;
  accountId: string;
  rentalId: string;
  amount: bigint;
  capturedAmount: bigint;
  status: HoldStatus;
  createdAt: number;
  resolvedAt?: number;
};

export class InsufficientFunds extends Error {
  constructor(
    readonly accountId: string,
    readonly requested: bigint,
    readonly available: bigint,
  ) {
    super(`Account ${accountId} has ${available} available but ${requested} was requested`);
    this.name = 'InsufficientFunds';
  }
}

export class LedgerConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerConflict';
  }
}
