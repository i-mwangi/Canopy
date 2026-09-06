"""Transport between the connectivity layer and the robots themselves.

Three backends are supported and all present the same interface:

* ``scenario`` drives the vendored HyperAgile simulator in ``robot-sim/`` through its own
  server. That server takes one call per leg, so this backend reports a leg at a time.
* ``file`` writes command files into a shared directory and waits for the controller to
  acknowledge them, a move at a time.
* ``http`` posts directly to a controller that exposes an HTTP endpoint, which is how a
  physical unit behind a tunnel is driven.

Pick with ``ROBOT_BACKEND=scenario``, ``file`` or ``http``.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Callable, Dict, Optional

import requests

BACKEND = os.environ.get("ROBOT_BACKEND", "scenario")
CONTROLLER_URL = os.environ.get("ROBOT_CONTROLLER_URL", "http://localhost:5002")
TASK_TIMEOUT_SECONDS = float(os.environ.get("TASK_TIMEOUT_SECONDS", "300"))
POLL_INTERVAL_SECONDS = 0.25

# A leg is an approach followed by a carry.
MOVES_PER_TASK = 2

# -- the vendored simulator ---------------------------------------------------------

WEBOTS_SERVER_URL = os.environ.get("WEBOTS_SERVER_URL", "http://localhost:5000")
WEBOTS_SIM_DIR = Path(os.environ.get("WEBOTS_SIM_DIR", "./robot-sim/robot-controllers"))

# Which of the simulator's scenarios runs which leg, and whose state file to watch while it
# does. The mapping is the simulator's own: scenario 1 picks, 2 packs, 3 delivers.
SCENARIOS = {
    "Picking": (1, "robot_1_controller"),
    "Packing": (2, "robot_2_controller"),
    "Delivery": (3, "robot_3_controller"),
}

# Which crate the order is for. The simulator's picking controller reaches to a different spot
# on the rack for each, and its server turns this into the colour code the controller reads.
WEBOTS_PRODUCT_ID = int(os.environ.get("WEBOTS_PRODUCT_ID", "0"))

# How many times to hand a leg over before giving up on it. See _run_scenario for why a leg
# can go missing without anything reporting a failure.
SCENARIO_ATTEMPTS = int(os.environ.get("SCENARIO_ATTEMPTS", "3"))

# What a controller writes into its state file. It starts at ready, the server sets it to go,
# and the controller writes finished once its task is done — then exits, having served one job.
STATE_FINISHED = "0"
STATE_READY = "1"
STATE_GO = "2"

# -- the file backend ---------------------------------------------------------------

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

    # -- leg execution --------------------------------------------------------------

    def run_leg(
        self,
        robot_class: str,
        robot_id: str,
        rental_id: str,
        leg_index: int,
        on_move: Optional[Callable[[int], None]] = None,
    ) -> None:
        """Runs one leg and blocks until the robot reports it complete.

        ``on_move`` is called with the number of this leg's moves finished so far, so a
        backend that can see a leg's halfway point says so and one that cannot reports the
        whole leg at once. The simulator is the second kind: it accepts a leg and tells us
        when the leg is done, with nothing observable in between.
        """
        if BACKEND == "scenario":
            self._run_scenario(robot_class, robot_id, rental_id)
            if on_move:
                on_move(MOVES_PER_TASK)
            return

        for move in range(MOVES_PER_TASK):
            command = {
                "rentalId": rental_id,
                "robotId": robot_id,
                "robotClass": robot_class,
                "taskIndex": leg_index,
                "moveIndex": move,
            }
            if BACKEND == "http":
                self._run_over_http(command)
            else:
                self._run_over_files(robot_class, robot_id, command)

            if on_move:
                on_move(move + 1)

    # -- backends -------------------------------------------------------------------

    def _run_scenario(self, robot_class: str, robot_id: str, rental_id: str) -> None:
        """Hands a leg to the simulator's own server and waits for its state file to finish.

        The server refuses unless the robot reports itself ready, which is also how a robot
        that is already working makes itself known.

        A dropped leg is retried. The simulator's controller parses its state file with no
        guard, and the server rewrites that file in place, so a read landing between the two
        can raise and take the controller down; Webots restarts it, it reports ready again,
        and the leg it was given is simply gone. Retrying costs one more run of a leg that
        had barely started, which is cheaper than failing an order over a lost file read.
        """
        scenario, controller = SCENARIOS.get(robot_class, (None, None))
        if scenario is None:
            raise RobotUnavailable(f"no scenario runs the {robot_class} leg")

        payload = {"orderId": rental_id, "robotId": int(robot_id), "productId": WEBOTS_PRODUCT_ID}
        state_path = WEBOTS_SIM_DIR / controller / "state.txt"

        for attempt in range(1, SCENARIO_ATTEMPTS + 1):
            try:
                response = requests.post(
                    f"{WEBOTS_SERVER_URL}/api/scenario{scenario}", json=payload, timeout=30
                )
            except requests.RequestException as error:
                raise RobotUnavailable(f"simulator server unreachable: {error}") from error

            if response.status_code != 200:
                detail = self._detail(response)
                raise RobotUnavailable(f"scenario{scenario} refused the leg: {detail}")

            if self._await_state(state_path, robot_class):
                return

            print(
                f"{robot_class} restarted before finishing its leg; "
                f"retrying ({attempt} of {SCENARIO_ATTEMPTS})",
                flush=True,
            )

        raise RobotUnavailable(
            f"the {robot_class} robot dropped its leg {SCENARIO_ATTEMPTS} times running"
        )

    def _await_state(self, state_path: Path, robot_class: str) -> bool:
        """Waits for the controller to finish. False if it restarted and lost the leg."""
        deadline = time.monotonic() + TASK_TIMEOUT_SECONDS

        while time.monotonic() < deadline:
            try:
                state = state_path.read_text(encoding="utf-8").strip()
            except OSError:
                state = ""

            if state == STATE_FINISHED:
                return True

            # Only a fresh controller writes ready, so seeing it again means this one died.
            if state == STATE_READY:
                return False

            time.sleep(POLL_INTERVAL_SECONDS)

        raise RobotUnavailable(
            f"the {robot_class} robot did not finish within {TASK_TIMEOUT_SECONDS:.0f}s"
        )

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

    @staticmethod
    def _detail(response: requests.Response) -> str:
        try:
            return str(response.json().get("error", response.text))
        except ValueError:
            return response.text

    def _read_status(self, path: Path) -> str:
        try:
            return path.read_text(encoding="utf-8").strip() or STATE_IDLE
        except FileNotFoundError:
            return STATE_IDLE

    @staticmethod
    def _key(robot_class: str, robot_id: str) -> str:
        return f"{robot_class.lower()}-{robot_id}"
