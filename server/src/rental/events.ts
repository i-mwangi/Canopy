export type RentalEventKind =
  | 'rental_started'
  | 'robot_assigned'
  | 'meter_recorded'
  | 'rental_completed'
  | 'fare_captured'
  | 'payout_transferred'
  | 'fee_transferred'
  | 'hold_released'
  | 'rental_settled'
  | 'rental_cancelled';

export type RentalEvent = {
  id: number;
  rentalId: string;
  kind: RentalEventKind;
  label: string;
  detail?: string;
  amount?: bigint;
  /** Circle's id for the transfer, known immediately. */
  transactionId?: string;
  /** The on-chain hash, known only once the transfer confirms. */
  txHash?: string;
  /** Phase the event belongs to, so the UI can group a rental into stages. */
  phase: 'authorize' | 'work' | 'settle';
  createdAt: number;
};

/**
 * Append-only record of what happened to a rental, in the order it happened. This is what the
 * rental page renders: the ledger says what a rental cost, this says how it got there.
 */
export class RentalEventLog {
  private readonly events: RentalEvent[] = [];
  private nextId = 1;

  append(event: Omit<RentalEvent, 'id' | 'createdAt'>): RentalEvent {
    const recorded: RentalEvent = { ...event, id: this.nextId++, createdAt: Date.now() };
    this.events.push(recorded);
    return recorded;
  }

  /**
   * Attaches the on-chain hash once a transfer confirms.
   *
   * Circle returns an id straight away but the hash only exists after the transaction lands,
   * so an event is written without one and filled in later. Without this the explorer links
   * would point at an id no block explorer has ever heard of.
   */
  attachTxHash(transactionId: string, txHash: string): void {
    for (const event of this.events) {
      if (event.transactionId === transactionId && !event.txHash) {
        event.txHash = txHash;
      }
    }
  }

  list(rentalId: string): RentalEvent[] {
    return this.events.filter((event) => event.rentalId === rentalId);
  }
}
