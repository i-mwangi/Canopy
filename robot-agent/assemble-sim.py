"""Lays out a runnable Webots project from the vendored simulator.

``robot-sim/`` is a copy of the HyperAgile simulator exactly as that repo stores it, which is
not the shape Webots wants: ``factory.wbt`` looks for its meshes at ``../stls/``, Webots looks
for controllers at ``../controllers/``, and the simulator's own server expects to run from a
directory holding the three controller folders alongside the status files it writes.

This arranges the vendored files into that shape without changing any of them. The world and
the meshes are hard links, so there is one world file and one set of meshes on disk however
many names they answer to. Only what the simulator writes to — the controllers and their
status files — is copied, so a run never dirties the vendored tree.

    python assemble-sim.py                  # builds ./sim
    webots sim/worlds/factory.wbt
    cd sim/controllers && python ../../robot-sim/connectivity-layer-server/webots.py
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "robot-sim"
TARGET = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "sim"

# Read-only for the length of a run, so these get a second name rather than a second copy.
# The controller sources are here too: no code is duplicated, only pointed at.
LINKED = [
    (SOURCE / "webot-world-setup" / "factory.wbt", TARGET / "worlds" / "factory.wbt"),
    (SOURCE / "robot-part-stl", TARGET / "stls"),
    (SOURCE / "robot-controllers" / "robot_1_controller", TARGET / "controllers" / "robot_1_controller"),
    (SOURCE / "robot-controllers" / "robot_2_controller", TARGET / "controllers" / "robot_2_controller"),
    (SOURCE / "robot-controllers" / "robot_3_controller", TARGET / "controllers" / "robot_3_controller"),
]

# The simulator writes to these. They are the only real copies, so a run leaves no mark on the
# vendored tree — a linked state file would rewrite the one the source repo tracks.
COPIED = [
    (SOURCE / "robot-controllers" / "robot_1_controller" / "state.txt", TARGET / "controllers" / "robot_1_controller" / "state.txt"),
    (SOURCE / "robot-controllers" / "robot_2_controller" / "state.txt", TARGET / "controllers" / "robot_2_controller" / "state.txt"),
    (SOURCE / "robot-controllers" / "robot_3_controller" / "state.txt", TARGET / "controllers" / "robot_3_controller" / "state.txt"),
    # The controllers read these one level above themselves, which is the controllers directory.
    (SOURCE / "robot-status-memory" / "color.txt", TARGET / "controllers" / "color.txt"),
    (SOURCE / "robot-status-memory" / "order.txt", TARGET / "controllers" / "order.txt"),
    (SOURCE / "robot-status-memory" / "robot.txt", TARGET / "controllers" / "robot.txt"),
]

# Never linked, whatever it is found next to: the simulator writes it.
WRITTEN = {"state.txt"}


def link_file(source: Path, destination: Path) -> None:
    """Gives a file a second name. Falls back to copying if the two cannot share a volume."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


def link_tree(source: Path, destination: Path) -> None:
    for entry in source.rglob("*"):
        if entry.is_file() and entry.name not in WRITTEN:
            link_file(entry, destination / entry.relative_to(source))


def main() -> None:
    if not SOURCE.is_dir():
        raise SystemExit(f"{SOURCE} is missing; the vendored simulator should be there")

    if TARGET.exists():
        shutil.rmtree(TARGET)

    for source, destination in LINKED:
        if source.is_dir():
            link_tree(source, destination)
        else:
            link_file(source, destination)

    for source, destination in COPIED:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)

    # Each robot reports itself ready; the simulator's server refuses a leg otherwise.
    for controller in TARGET.glob("controllers/robot_?_controller"):
        (controller / "state.txt").write_text("1", encoding="utf-8")

    print(f"assembled {TARGET}")
    print(f"  webots {TARGET / 'worlds' / 'factory.wbt'}")
    print(f"  cd {TARGET / 'controllers'} && python {SOURCE / 'connectivity-layer-server' / 'webots.py'}")


if __name__ == "__main__":
    main()
