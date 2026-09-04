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
  /** Set once the write that produced this event has a transaction behind it. */
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

  /** Attaches a transaction hash to the most recent event of a kind, once it is known. */
  attachTx(rentalId: string, kind: RentalEventKind, txHash: string): void {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (event && event.rentalId === rentalId && event.kind === kind && !event.txHash) {
        event.txHash = txHash;
        return;
      }
    }
  }

  list(rentalId: string): RentalEvent[] {
    return this.events.filter((event) => event.rentalId === rentalId);
  }
}
