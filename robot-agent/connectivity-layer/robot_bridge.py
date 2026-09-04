"""Transport between the connectivity layer and the robots themselves.

Two backends are supported and both present the same interface:

* ``file`` writes command files into a shared directory and waits for the controller to
  acknowledge them. This is how a simulated fleet is driven, where the controller polls its
  own state file each timestep.
* ``http`` posts directly to a controller that exposes an HTTP endpoint, which is how a
  physical unit behind a tunnel is driven.

Pick with ``ROBOT_BACKEND=file`` or ``ROBOT_BACKEND=http``.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Dict

import requests

BACKEND = os.environ.get("ROBOT_BACKEND", "file")
CONTROLLER_URL = os.environ.get("ROBOT_CONTROLLER_URL", "http://localhost:5002")
TASK_TIMEOUT_SECONDS = float(os.environ.get("TASK_TIMEOUT_SECONDS", "120"))
POLL_INTERVAL_SECONDS = 0.25

# What a controller writes into its status file when it has finished the command it was given.
STATE_IDLE = "idle"
STATE_BUSY = "busy"
STATE_DONE = "done"
STATE_FAULT = "fault"


class RobotUnavailable(RuntimeError):
    """Raised when a robot cannot take a job, or fails partway through one."""


class RobotBridge:
    def __init__(self, state_dir: str) -> None:
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self._claimed: Dict[str, str] = {}
        self._lock = threading.Lock()

    # -- capacity -------------------------------------------------------------------

    def claim(self, robot_class: str, robot_id: str) -> None:
        """Reserves a robot locally so two jobs cannot drive the same unit."""
        key = self._key(robot_class, robot_id)
        with self._lock:
            if key in self._claimed:
                raise RobotUnavailable(f"{key} is already running a job")
            self._claimed[key] = "claimed"

    def release(self, robot_class: str, robot_id: str) -> None:
        with self._lock:
            self._claimed.pop(self._key(robot_class, robot_id), None)

    def snapshot(self) -> Dict[str, str]:
        with self._lock:
            return dict(self._claimed)

    # -- task execution -------------------------------------------------------------

    def run_task(self, robot_class: str, robot_id: str, rental_id: str, task_index: int) -> None:
        """Runs one task and blocks until the robot reports it complete."""
        command = {
            "rentalId": rental_id,
            "robotId": robot_id,
            "robotClass": robot_class,
            "taskIndex": task_index,
        }

        if BACKEND == "http":
            self._run_over_http(command)
        else:
            self._run_over_files(robot_class, robot_id, command)

    def _run_over_http(self, command: dict) -> None:
        try:
            response = requests.post(f"{CONTROLLER_URL}/task", json=command, timeout=TASK_TIMEOUT_SECONDS)
            response.raise_for_status()
        except requests.RequestException as error:
            raise RobotUnavailable(f"controller rejected the task: {error}") from error

        body = response.json()
        if body.get("state") != "done":
            raise RobotUnavailable(f"controller reported {body.get('state', 'unknown')}")

    def _run_over_files(self, robot_class: str, robot_id: str, command: dict) -> None:
        key = self._key(robot_class, robot_id)
        command_path = self.state_dir / f"{key}.command.json"
        status_path = self.state_dir / f"{key}.status"

        status = self._read_status(status_path)
        if status == STATE_BUSY:
            raise RobotUnavailable(f"{key} is busy")

        # The controller polls for a command file, so write the command before flipping state.
        command_path.write_text(json.dumps(command), encoding="utf-8")
        status_path.write_text(STATE_BUSY, encoding="utf-8")

        deadline = time.monotonic() + TASK_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            status = self._read_status(status_path)

            if status == STATE_DONE:
                status_path.write_text(STATE_IDLE, encoding="utf-8")
                command_path.unlink(missing_ok=True)
                return

            if status == STATE_FAULT:
                command_path.unlink(missing_ok=True)
                raise RobotUnavailable(f"{key} reported a fault")

            time.sleep(POLL_INTERVAL_SECONDS)

        command_path.unlink(missing_ok=True)
        raise RobotUnavailable(f"{key} did not finish within {TASK_TIMEOUT_SECONDS:.0f}s")

    # -- helpers --------------------------------------------------------------------

    def _read_status(self, path: Path) -> str:
        try:
            return path.read_text(encoding="utf-8").strip() or STATE_IDLE
        except FileNotFoundError:
            return STATE_IDLE

    @staticmethod
    def _key(robot_class: str, robot_id: str) -> str:
        return f"{robot_class.lower()}-{robot_id}"
