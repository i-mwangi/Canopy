"""Robot-side controller.

Runs next to the robot — inside a simulator timestep loop, or on the unit itself. It polls
for a command file, executes the motion, and writes back a status the connectivity layer is
watching for. It knows nothing about rentals, fares, or wallets.

Run standalone against the file backend:
    python controller.py --class Picking --id 0

Inside a simulator, call ``poll()`` once per timestep instead of using the loop below.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Callable, Optional

STATE_IDLE = "idle"
STATE_BUSY = "busy"
STATE_DONE = "done"
STATE_FAULT = "fault"


class Controller:
    def __init__(
        self,
        robot_class: str,
        robot_id: str,
        state_dir: str = "./state",
        execute: Optional[Callable[[dict], None]] = None,
    ) -> None:
        self.key = f"{robot_class.lower()}-{robot_id}"
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)

        self.command_path = self.state_dir / f"{self.key}.command.json"
        self.status_path = self.state_dir / f"{self.key}.status"

        # Swap this for the real motion routine: an arm trajectory, a nav goal, a conveyor run.
        self.execute = execute or self._simulate_motion

        self.status_path.write_text(STATE_IDLE, encoding="utf-8")

    def poll(self) -> bool:
        """Runs one pending command if there is one. Returns True if work was done."""
        if self._status() != STATE_BUSY:
            return False

        try:
            command = json.loads(self.command_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return False

        try:
            self.execute(command)
        except Exception as error:  # noqa: BLE001 - a fault must reach the connectivity layer
            print(f"[{self.key}] fault: {error}")
            self.status_path.write_text(STATE_FAULT, encoding="utf-8")
            return True

        self.status_path.write_text(STATE_DONE, encoding="utf-8")
        return True

    def run_forever(self, interval: float = 0.25) -> None:
        print(f"[{self.key}] waiting for commands in {self.state_dir}")
        while True:
            self.poll()
            time.sleep(interval)

    def _status(self) -> str:
        try:
            return self.status_path.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            return STATE_IDLE

    def _simulate_motion(self, command: dict) -> None:
        """Stands in for the real motion. Each task takes a few seconds of runtime."""
        task_index = command.get("taskIndex", 0)
        print(f"[{self.key}] running task {task_index} for rental {command.get('rentalId')}")
        time.sleep(3)
        print(f"[{self.key}] task {task_index} complete")


def main() -> None:
    parser = argparse.ArgumentParser(description="Robot controller")
    parser.add_argument("--class", dest="robot_class", default="Picking")
    parser.add_argument("--id", dest="robot_id", default="0")
    parser.add_argument("--state-dir", dest="state_dir", default="./state")
    args = parser.parse_args()

    Controller(args.robot_class, args.robot_id, args.state_dir).run_forever()


if __name__ == "__main__":
    main()
