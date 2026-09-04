"""End-to-end check of the connectivity layer against a stub marketplace.

Dispatches a job, drives a controller through its tasks, and asserts that the meter readings
that reach the marketplace are monotonic and that the job settles exactly once.

    python test_connectivity.py
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from json import dumps, loads

STATE_DIR = tempfile.mkdtemp(prefix="robot-agent-test-")

os.environ["ROBOT_STATE_DIR"] = STATE_DIR
os.environ["METER_INTERVAL_SECONDS"] = "0.3"
os.environ["TASK_TIMEOUT_SECONDS"] = "20"
os.environ["ROBOT_BACKEND"] = "file"

received: list[tuple[str, dict]] = []
received_lock = threading.Lock()


class StubMarketplace(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        length = int(self.headers.get("content-length", "0"))
        body = loads(self.rfile.read(length) or b"{}")

        with received_lock:
            received.append((self.path, body))

        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(dumps({"ok": True}).encode())

    def log_message(self, *args):  # noqa: D102 - silence the default access log
        pass


def calls(suffix: str) -> list[dict]:
    with received_lock:
        return [body for path, body in received if path.endswith(suffix)]


def main() -> int:
    marketplace = HTTPServer(("127.0.0.1", 0), StubMarketplace)
    port = marketplace.server_address[1]
    threading.Thread(target=marketplace.serve_forever, daemon=True).start()

    os.environ["MARKETPLACE_API_URL"] = f"http://127.0.0.1:{port}"

    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "connectivity-layer"))
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "controllers"))

    import app as connectivity  # noqa: PLC0415 - imported after the environment is set
    from controller import Controller  # noqa: PLC0415

    client = connectivity.app.test_client()

    controller = Controller("Picking", "0", state_dir=STATE_DIR)
    stop = threading.Event()

    def drive():
        while not stop.is_set():
            controller.poll()
            time.sleep(0.05)

    threading.Thread(target=drive, daemon=True).start()

    # Keep the simulated motion short so the test finishes quickly.
    controller.execute = lambda command: time.sleep(0.2)

    response = client.post(
        "/dispatch",
        json={"rentalId": "rental-1", "robotId": "0", "robotClass": "Picking", "tasks": 3},
    )
    assert response.status_code == 202, f"dispatch returned {response.status_code}"

    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if calls("/settle"):
            break
        time.sleep(0.1)

    stop.set()
    marketplace.shutdown()

    meters = calls("/meter")
    completes = calls("/complete")
    settles = calls("/settle")

    assert meters, "no meter readings reached the marketplace"
    assert len(completes) == 1, f"expected one complete call, saw {len(completes)}"
    assert len(settles) == 1, f"expected one settle call, saw {len(settles)}"

    minutes = [reading["meteredMinutes"] for reading in meters]
    tasks = [reading["tasksCompleted"] for reading in meters]

    assert minutes == sorted(minutes), f"meter minutes went backwards: {minutes}"
    assert tasks == sorted(tasks), f"task count went backwards: {tasks}"
    assert completes[0]["tasksCompleted"] == 3, f"final reading was {completes[0]}"
    assert completes[0]["meteredMinutes"] >= max(minutes), "final reading regressed"

    status = client.get("/jobs/rental-1").get_json()
    assert status["finished"] is True
    assert status["error"] is None, f"job faulted: {status['error']}"

    print(f"ok — {len(meters)} meter readings, final {completes[0]}")
    shutil.rmtree(STATE_DIR, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
