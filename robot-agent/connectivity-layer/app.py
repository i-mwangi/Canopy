"""Connectivity layer between the marketplace and a robot fleet.

The marketplace dispatches a job here; this process hands it to whichever robot is bound to
that class, watches the robot report progress, and pushes meter readings back to the
marketplace API. Robots never talk to the marketplace directly and never hold a credential
beyond the shared agent token.

Run:
    FLASK_APP=app.py flask run --port 5001
"""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, Optional

import requests
from flask import Flask, jsonify, request

from robot_bridge import RobotBridge, RobotUnavailable

API_URL = os.environ.get("MARKETPLACE_API_URL", "http://localhost:8080")
AGENT_TOKEN = os.environ.get("AGENT_TOKEN", "")
METER_INTERVAL_SECONDS = float(os.environ.get("METER_INTERVAL_SECONDS", "15"))
STATE_DIR = os.environ.get("ROBOT_STATE_DIR", "./state")

# A leg is an approach followed by a carry. Both are reported, so the floor plan can fill in
# one arrow at a time rather than jumping a whole leg at once.
MOVES_PER_TASK = 2

# An order is picked, packed and delivered, one robot per leg.
ORDER_CLASSES = ("Picking", "Packing", "Delivery")

app = Flask(__name__)


@dataclass
class Job:
    """One dispatched rental, tracked while its robot works."""

    rental_id: str
    """One dispatched order, tracked while its three robots work in turn."""

    robots: dict
    started_at: float
    moves_completed: int = 0
    finished: bool = False
    error: Optional[str] = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    def metered_minutes(self) -> float:
        return (time.monotonic() - self.started_at) / 60.0

    def reading(self) -> dict:
        """What the marketplace is told: finished moves only.

        Runtime is measured by the marketplace between dispatch and completion, so reporting
        minutes from here would be a number nobody bills on and two clocks to reconcile.
        """
        return {"movesCompleted": self.moves_completed}

    def local_reading(self) -> dict:
        """Everything the agent knows, for its own status endpoint."""
        return {
            "meteredMinutes": round(self.metered_minutes(), 4),
            "movesCompleted": self.moves_completed,
            "tasksCompleted": self.moves_completed // MOVES_PER_TASK,
        }


jobs: Dict[str, Job] = {}
jobs_lock = threading.Lock()
bridge = RobotBridge(state_dir=STATE_DIR)


def authorized() -> bool:
    if not AGENT_TOKEN:
        return True
    return request.headers.get("x-agent-token") == AGENT_TOKEN


def post_to_marketplace(path: str, payload: dict) -> Optional[dict]:
    """Best-effort call to the marketplace. A dropped reading is recovered by the next one."""
    try:
        response = requests.post(f"{API_URL}{path}", json=payload, timeout=10)
        response.raise_for_status()
        return response.json()
    except requests.RequestException as error:
        app.logger.warning("marketplace call %s failed: %s", path, error)
        return None


def meter_loop(job: Job) -> None:
    """Pushes a reading on a fixed cadence until the robot reports the job done.

    Readings are cumulative and monotonic, so the marketplace can drop a duplicate or a
    late-arriving one without corrupting the fare.
    """
    while True:
        with job.lock:
            if job.finished:
                break
            reading = job.reading()

        post_to_marketplace(f"/rentals/{job.rental_id}/meter", reading)
        time.sleep(METER_INTERVAL_SECONDS)

    with job.lock:
        final = job.reading()
        failed = job.error is not None
        reason = job.error

    if failed:
        post_to_marketplace(f"/rentals/{job.rental_id}/cancel", {"reason": reason})
    else:
        post_to_marketplace(f"/rentals/{job.rental_id}/complete", final)
        post_to_marketplace(f"/rentals/{job.rental_id}/settle", {})


def run_job(job: Job) -> None:
    """Drives the order through its three legs.

    The legs run in sequence because each hands the item to the next: nothing can be packed
    before it is picked. How much of a leg is visible from here is the backend's business —
    the simulator reports a finished leg, a controller driven a move at a time reports each
    move — so progress is reported through a callback rather than counted in this loop.
    """
    try:
        for index, robot_class in enumerate(ORDER_CLASSES):
            robot_id = job.robots[robot_class]

            def report(moves_done: int, index: int = index) -> None:
                with job.lock:
                    job.moves_completed = index * MOVES_PER_TASK + moves_done

                # Report as it happens rather than waiting for the cadence, so the floor plan
                # fills in as the robots work.
                post_to_marketplace(f"/rentals/{job.rental_id}/meter", job.reading())

            bridge.run_leg(robot_class, robot_id, job.rental_id, index, on_move=report)
    except RobotUnavailable as error:
        with job.lock:
            job.error = str(error)
    except Exception as error:  # noqa: BLE001 - any failure must stop the meter
        with job.lock:
            job.error = f"robot fault: {error}"
    finally:
        with job.lock:
            job.finished = True
        for robot_class, robot_id in job.robots.items():
            bridge.release(robot_class, robot_id)


@app.post("/dispatch")
def dispatch():
    """Accepts a job from the marketplace and starts the meter."""
    if not authorized():
        return jsonify({"error": "unauthorized"}), 401

    payload = request.get_json(silent=True) or {}
    rental_id = payload.get("rentalId")
    robots = payload.get("robots") or {}

    missing = [name for name in ORDER_CLASSES if not robots.get(name)]
    if not rental_id or missing:
        return jsonify({"error": f"rentalId and a robot per leg are required; missing {missing}"}), 400

    waiting = bridge.not_ready()
    if waiting:
        return jsonify({"error": f"fleet not ready: {', '.join(waiting)}"}), 503

    with jobs_lock:
        if rental_id in jobs:
            return jsonify({"error": "order already dispatched"}), 409

        claimed = []
        try:
            for robot_class in ORDER_CLASSES:
                bridge.claim(robot_class, str(robots[robot_class]))
                claimed.append((robot_class, str(robots[robot_class])))
        except RobotUnavailable as error:
            # An order needs all three; releasing what was taken avoids stranding a robot.
            for robot_class, robot_id in claimed:
                bridge.release(robot_class, robot_id)
            return jsonify({"error": str(error)}), 503

        job = Job(
            rental_id=rental_id,
            robots={name: str(robots[name]) for name in ORDER_CLASSES},
            started_at=time.monotonic(),
        )
        jobs[rental_id] = job

    threading.Thread(target=run_job, args=(job,), daemon=True).start()
    threading.Thread(target=meter_loop, args=(job,), daemon=True).start()

    return jsonify({"state": "dispatched", "rentalId": rental_id, "robots": job.robots}), 202


@app.get("/jobs/<rental_id>")
def job_status(rental_id: str):
    if not authorized():
        return jsonify({"error": "unauthorized"}), 401

    job = jobs.get(rental_id)
    if job is None:
        return jsonify({"error": "unknown rental"}), 404

    with job.lock:
        return jsonify(
            {
                "rentalId": job.rental_id,
                "robots": job.robots,
                "finished": job.finished,
                "error": job.error,
                **job.local_reading(),
            }
        )


@app.post("/jobs/<rental_id>/abort")
def abort(rental_id: str):
    """Stops a job early. The marketplace settles whatever the meter recorded."""
    if not authorized():
        return jsonify({"error": "unauthorized"}), 401

    job = jobs.get(rental_id)
    if job is None:
        return jsonify({"error": "unknown rental"}), 404

    with job.lock:
        job.finished = True

    return jsonify({"state": "aborting"}), 202


@app.get("/ready")
def ready():
    """Whether the fleet can take an order, and which legs cannot if not.

    The marketplace asks this before it reserves anything, so a fleet that has already run
    is a refusal to place the order rather than an order placed and then cancelled.
    """
    if not authorized():
        return jsonify({"error": "unauthorized"}), 401

    waiting = bridge.not_ready()
    return jsonify(
        {
            "ready": not waiting,
            "robots": bridge.readiness(),
            "detail": (
                ""
                if not waiting
                else f"{', '.join(waiting)} not ready; reload the world in Webots to reset the fleet"
            ),
        }
    )


@app.get("/health")
def health():
    return jsonify(
        {
            "robots": bridge.snapshot(),
            "activeJobs": len(jobs),
            "fleet": bridge.readiness(),
        }
    )


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", "5001")))
