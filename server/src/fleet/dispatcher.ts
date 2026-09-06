import { MOVES_PER_TASK } from '../pricing/fare.ts';
import type { RobotClass } from './registry.ts';

/** How the connectivity layer names the classes in its dispatch payload. */
const AGENT_CLASS_NAMES: Record<RobotClass, string> = {
  0: 'Picking',
  1: 'Packing',
  2: 'Delivery',
};

export type DispatchedOrder = {
  rentalId: string;
  legs: { class_: RobotClass; robotId: bigint }[];
};

/**
 * What the fleet reports back while it works.
 *
 * The connectivity layer makes these calls over HTTP; a fleet running inside this process
 * makes them directly. Either way progress reaches the marketplace by the same route, so
 * there is one path through which a fare can grow.
 */
export interface MeterSink {
  recordMeter(rentalId: string, progress: { movesCompleted: number }): Promise<unknown>;
  cancelRental(rentalId: string, reason: string): Promise<unknown>;
}

export type FleetReadiness = { ready: boolean; detail: string };

/**
 * Sets a placed order running.
 *
 * Placing an order is the instruction; nothing afterwards asks the fleet to take its next
 * step. A renter is buying a finished delivery, not a remote control.
 */
export interface FleetDispatcher {
  /** Whether the fleet could take an order now. Asked before anything is reserved. */
  ready(): Promise<FleetReadiness>;
  /** Returns once the fleet has accepted the job, not once the job is done. */
  dispatch(order: DispatchedOrder): Promise<void>;
  /** Stops a job early. Best effort: the marketplace has already stopped billing for it. */
  abort(rentalId: string): Promise<void>;
  /** Wires up where progress is reported. Called once, before the first dispatch. */
  attach(sink: MeterSink): void;
}

export class FleetDispatchFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetDispatchFailed';
  }
}

/**
 * Hands the order to the robot connectivity layer, which drives the real fleet.
 *
 * Progress comes back to the marketplace API as the robots finish moves, so nothing is
 * reported here.
 */
export class AgentFleetDispatcher implements FleetDispatcher {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  attach(): void {}

  async ready(): Promise<FleetReadiness> {
    try {
      const response = await fetch(`${this.baseUrl}/ready`, {
        headers: this.token ? { 'x-agent-token': this.token } : {},
      });
      if (!response.ok) return { ready: false, detail: `the fleet did not answer: ${response.status}` };

      const body = (await response.json()) as { ready?: boolean; detail?: string };
      return { ready: body.ready === true, detail: body.detail ?? '' };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'the fleet could not be reached';
      return { ready: false, detail };
    }
  }

  async dispatch(order: DispatchedOrder): Promise<void> {
    const robots = Object.fromEntries(
      order.legs.map((leg) => [AGENT_CLASS_NAMES[leg.class_], leg.robotId.toString()]),
    );

    const response = await this.post('/dispatch', { rentalId: order.rentalId, robots });
    if (!response.ok) {
      throw new FleetDispatchFailed(`Fleet refused the order: ${response.status} ${await response.text()}`);
    }
  }

  async abort(rentalId: string): Promise<void> {
    try {
      await this.post(`/jobs/${rentalId}/abort`, {});
    } catch {
      // The order is already cancelled here; a robot finishing its current move changes nothing.
    }
  }

  private post(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { 'x-agent-token': this.token } : {}),
      },
      body: JSON.stringify(body),
    });
  }
}

/**
 * Walks the order through its moves in this process, at a fixed pace.
 *
 * Stands in for the fleet when no connectivity layer is attached, so the marketplace can be
 * exercised end to end without a simulator running. It reports the same readings a real
 * robot would, which is why the order still settles on measured time rather than on a
 * duration anyone typed in.
 */
export class SimulatedFleetDispatcher implements FleetDispatcher {
  private sink?: MeterSink;
  private readonly running = new Set<string>();

  constructor(private readonly secondsPerMove: number) {}

  attach(sink: MeterSink): void {
    this.sink = sink;
  }

  async ready(): Promise<FleetReadiness> {
    return { ready: true, detail: '' };
  }

  async dispatch(order: DispatchedOrder): Promise<void> {
    if (this.running.has(order.rentalId)) return;
    this.running.add(order.rentalId);
    void this.run(order);
  }

  async abort(rentalId: string): Promise<void> {
    this.running.delete(rentalId);
  }

  private async run(order: DispatchedOrder): Promise<void> {
    const moves = order.legs.length * MOVES_PER_TASK;

    try {
      for (let move = 1; move <= moves; move += 1) {
        await sleep(this.secondsPerMove * 1_000);
        // A cancelled order is no longer ours to advance.
        if (!this.running.has(order.rentalId)) return;

        await this.sink?.recordMeter(order.rentalId, { movesCompleted: move });
      }
    } catch (error) {
      // A robot that stops mid-route means the item never arrived, so the renter keeps their
      // authorization. This matches what the connectivity layer does with a robot fault.
      const reason = error instanceof Error ? error.message : 'the fleet stopped unexpectedly';
      await this.sink?.cancelRental(order.rentalId, reason).catch(() => undefined);
    } finally {
      this.running.delete(order.rentalId);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
