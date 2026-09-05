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

app = Flask(__name__)


@dataclass
class Job:
    """One dispatched rental, tracked while its robot works."""

    rental_id: str
    robot_id: str
    robot_class: str
    started_at: float
    tasks_total: int
    tasks_completed: int = 0
    finished: bool = False
    error: Optional[str] = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    def metered_minutes(self) -> float:
        return (time.monotonic() - self.started_at) / 60.0

    def reading(self) -> dict:
        """What the marketplace is told: finished work only.

        Runtime is measured by the marketplace between dispatch and completion, so reporting
        minutes from here would be a number nobody bills on and two clocks to reconcile.
        """
        return {"tasksCompleted": self.tasks_completed}

    def local_reading(self) -> dict:
        """Everything the agent knows, for its own status endpoint."""
        return {
            "meteredMinutes": round(self.metered_minutes(), 4),
            "tasksCompleted": self.tasks_completed,
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
    """Drives the robot through the job, one task at a time."""
    try:
        for index in range(job.tasks_total):
            bridge.run_task(job.robot_class, job.robot_id, job.rental_id, index)
            with job.lock:
                job.tasks_completed = index + 1
    except RobotUnavailable as error:
        with job.lock:
            job.error = str(error)
    except Exception as error:  # noqa: BLE001 - any failure must stop the meter
        with job.lock:
            job.error = f"robot fault: {error}"
    finally:
        with job.lock:
            job.finished = True
        bridge.release(job.robot_class, job.robot_id)


@app.post("/dispatch")
def dispatch():
    """Accepts a job from the marketplace and starts the meter."""
    if not authorized():
        return jsonify({"error": "unauthorized"}), 401

    payload = request.get_json(silent=True) or {}
    rental_id = payload.get("rentalId")
    robot_id = str(payload.get("robotId", ""))
    robot_class = payload.get("robotClass", "Picking")
    tasks_total = int(payload.get("tasks", 1))

    if not rental_id or not robot_id:
        return jsonify({"error": "rentalId and robotId are required"}), 400

    with jobs_lock:
        if rental_id in jobs:
            return jsonify({"error": "rental already dispatched"}), 409

        try:
            bridge.claim(robot_class, robot_id)
        except RobotUnavailable as error:
            return jsonify({"error": str(error)}), 503

        job = Job(
            rental_id=rental_id,
            robot_id=robot_id,
            robot_class=robot_class,
            started_at=time.monotonic(),
            tasks_total=tasks_total,
        )
        jobs[rental_id] = job

    threading.Thread(target=run_job, args=(job,), daemon=True).start()
    threading.Thread(target=meter_loop, args=(job,), daemon=True).start()

    return jsonify({"state": "dispatched", "rentalId": rental_id, "robotId": robot_id}), 202


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
                "robotId": job.robot_id,
                "robotClass": job.robot_class,
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


@app.get("/health")
def health():
    return jsonify({"robots": bridge.snapshot(), "activeJobs": len(jobs)})


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", "5001")))
