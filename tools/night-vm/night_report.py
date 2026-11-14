#!/usr/bin/env python3
"""Reads a night run directory: how the run ended, what it cost, what came back.

    night_report.py classify <run-dir> <failed-phase> <vm-result> <exit-status> <interrupted>
    night_report.py status <runs-dir> [<run-id>]

`classify` settles a finished run into `result.json` (passed, failed or cut) and
prints its state. `status` prints one line per run, or the detail of one run.
Everything read under `pipeline-history/` came back from the VM: it is parsed,
never executed, and a malformed file reads as absent.
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

MAX_RECORD_BYTES = 4 * 1024 * 1024


def read_json(path: Path) -> object:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_RECORD_BYTES:
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def scan_records(run_dir: Path) -> list[dict]:
    scans = run_dir / "pipeline-history" / "scans"
    if not scans.is_dir() or scans.is_symlink():
        return []
    records = [read_json(path) for path in sorted(scans.glob("*.json"))]
    return [record for record in records if isinstance(record, dict)]


def ticket_outcomes(records: list[dict]) -> dict[str, str]:
    """Latest word on each ticket the night touched, across resumed scans."""
    outcomes: dict[str, str] = {}
    for record in records:
        tickets = record.get("tickets")
        if not isinstance(tickets, dict):
            continue
        for ticket, entry in tickets.items():
            if not isinstance(entry, dict):
                continue
            if entry.get("state") == "done":
                outcomes[str(ticket)] = str(entry.get("outcome"))
            elif entry.get("state") == "running":
                outcomes[str(ticket)] = "interrupted"
    return outcomes


def cost_usd(run_dir: Path) -> float | None:
    path = run_dir / "pipeline-history" / "runs.jsonl"
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_RECORD_BYTES:
        return None
    latest: dict[str, dict] = {}
    for line in path.read_text().splitlines():
        try:
            run = json.loads(line)
        except ValueError:
            continue
        # A nested run's spend is already folded into its parent's step.
        if isinstance(run, dict) and isinstance(run.get("runId"), str) and not run.get("parentRunId"):
            latest[run["runId"]] = run
    costs = [run.get("costUsd") for run in latest.values()]
    return sum(float(cost) for cost in costs if isinstance(cost, (int, float)))


def branches(run_dir: Path) -> list[str]:
    bundle = run_dir / "out.bundle"
    if bundle.is_symlink() or not bundle.is_file():
        return []
    listed = subprocess.run(["git", "bundle", "list-heads", str(bundle)],
                            capture_output=True, text=True, check=False)
    refs = [line.split()[-1] for line in listed.stdout.splitlines() if line.strip()]
    return [ref.removeprefix("refs/heads/") for ref in refs]


def classify(run_dir: Path, failed_phase: str, vm_result: str, exit_status: str, interrupted: str) -> tuple[str, str]:
    if interrupted == "1":
        return "cut", "the host unit was stopped (shutdown, reboot or systemctl stop)"
    if vm_result == "timeout":
        return "cut", "the run reached its time limit"
    if failed_phase:
        return "failed", f"phase {failed_phase} failed"
    if exit_status != "0":
        return "failed", f"the VM run exited {exit_status or 'without a status'} (run.log)"
    records = scan_records(run_dir)
    if not records:
        return "failed", "no scan record came back"
    last = records[-1]
    if last.get("abort"):
        return "failed", f"scan aborted ({json.dumps(last['abort'])[:200]})"
    if not last.get("finishedAt"):
        return "failed", "the scan did not reach its report"
    outcomes = ticket_outcomes(records)
    unsettled = {ticket: outcome for ticket, outcome in outcomes.items() if outcome != "fixed"}
    if unsettled:
        return "failed", ", ".join(f"#{ticket} {outcome}" for ticket, outcome in sorted(unsettled.items()))
    if outcomes and not (run_dir / "phases" / "bundle-verified").is_file():
        return "failed", "fixed tickets but no verified bundle"
    return "passed", ", ".join(f"#{ticket} fixed" for ticket in sorted(outcomes)) or "queue empty"


def host_unit_active(run_id: str) -> bool:
    return subprocess.run(["systemctl", "--user", "is-active", "--quiet", f"nuit-{run_id}"],
                          check=False).returncode == 0


def vm_state(run_id: str) -> str:
    queried = subprocess.run(["incus", "query", f"/1.0/instances/nuit-{run_id}"],
                             capture_output=True, text=True, check=False)
    try:
        return str(json.loads(queried.stdout)["status"]).lower() if queried.returncode == 0 else "-"
    except (ValueError, KeyError, TypeError):
        return "-"


def summary(run_dir: Path) -> dict:
    run_id = run_dir.name
    result = read_json(run_dir / "result.json")
    result = result if isinstance(result, dict) else {}
    markers = (run_dir / "phases").glob("*") if (run_dir / "phases").is_dir() else []
    phases = [path.name for path in sorted(markers, key=lambda path: path.stat().st_mtime)]
    if host_unit_active(run_id):
        state = f"running ({phases[-1] if phases else 'starting'})"
    else:
        state = str(result.get("state") or "cut")
    cost = cost_usd(run_dir)
    return {
        "run": run_id,
        "state": state,
        "reason": result.get("reason") or ("no result: the host unit died before settling" if state == "cut" else ""),
        "cost": "-" if cost is None else f"${cost:.2f}",
        "branches": branches(run_dir),
        "vm": vm_state(run_id),
        "tickets": ticket_outcomes(scan_records(run_dir)),
        "phases": phases,
    }


def print_table(rows: list[dict]) -> None:
    print(f"{'RUN':<34} {'STATE':<22} {'COST':>8}  {'BRANCHES':<20} VM")
    for row in rows:
        print(f"{row['run']:<34} {row['state']:<22} {row['cost']:>8}  "
              f"{(' '.join(row['branches']) or '-'):<20} {row['vm']}")


def print_detail(row: dict, run_dir: Path) -> None:
    print_table([row])
    print()
    print(f"reason:   {row['reason'] or '-'}")
    print("tickets:  " + (", ".join(f"#{t} {o}" for t, o in sorted(row["tickets"].items())) or "-"))
    print("phases:   " + (" ".join(row["phases"]) or "-"))
    print(f"run dir:  {run_dir}")
    for name in ("night.log", "prepare.log", "run.log", "gh-broker.log", "worktree.patch"):
        if (run_dir / name).is_file():
            print(f"          {name}")
    if row["vm"] not in ("-", ""):
        print(f"VM kept:  nuit-{row['run']} ({row['vm']}); remove it with: night.sh clean {row['run']}")


def main(argv: list[str]) -> int:
    if len(argv) == 6 and argv[0] == "classify":
        run_dir = Path(argv[1])
        state, reason = classify(run_dir, *argv[2:])
        (run_dir / "result.json").write_text(json.dumps({
            "state": state, "reason": reason, "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }) + "\n")
        print(state)
        return 0
    if argv and argv[0] == "status" and len(argv) in (2, 3):
        runs_dir = Path(argv[1])
        if len(argv) == 3:
            run_dir = runs_dir / argv[2]
            if not (run_dir / "run.env").is_file():
                print(f"no night run {argv[2]} under {runs_dir}", file=sys.stderr)
                return 1
            print_detail(summary(run_dir), run_dir)
            return 0
        dirs = sorted(path for path in runs_dir.glob("*") if (path / "run.env").is_file()) if runs_dir.is_dir() else []
        print_table([summary(path) for path in dirs])
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
