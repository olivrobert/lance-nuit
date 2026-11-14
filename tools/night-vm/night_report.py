#!/usr/bin/env python3
"""Reads a night run directory: how the run ended, what it cost, what came back.

    night_report.py classify <run-dir> <failed-phase> <vm-result> <exit-status> <interrupted>
    night_report.py status <runs-dir> [<run-id>]
    night_report.py live <run-dir> [<live-archive>]

`classify` settles a finished run into `result.json` (passed, failed or cut) and
prints its state. `status` prints one line per run, or the detail of one run.
`live` unpacks the archive pulled from the VM, if given, into `live/`, then
writes `live.json`: where the night and each of its tickets stand (format in
LIVE.md). Everything read under `pipeline-history/`, `work-items/` and `live/`
came back from the VM: it is parsed, never executed, and a malformed file reads
as absent.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path

MAX_RECORD_BYTES = 4 * 1024 * 1024
MAX_LIVE_MEMBERS = 1000
MAX_LIVE_BYTES = 32 * 1024 * 1024
MAX_TEXT = 2000
LIVE_FORMAT = "night-live/1"
NIGHT_PHASES = ("vm", "secrets", "boot", "code", "broker", "prepare", "run")
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


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


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def mtime_iso(path: Path) -> str | None:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")
    except OSError:
        return None


def text(value: object, limit: int = MAX_TEXT) -> str | None:
    return value[:limit] if isinstance(value, str) else None


def number(value: object) -> float | int | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def mapping(value: object) -> dict:
    return value if isinstance(value, dict) else {}


def unpack_live(run_dir: Path, archive: Path) -> bool:
    """Swaps `live/` for what the VM sent, or leaves the previous one untouched."""
    if archive.is_symlink() or not archive.is_file() or archive.stat().st_size > MAX_LIVE_BYTES:
        return False
    part = run_dir / "live.part"
    shutil.rmtree(part, ignore_errors=True)
    part.mkdir()
    try:
        with tarfile.open(archive) as tar:
            members = tar.getmembers()
            if (len(members) > MAX_LIVE_MEMBERS or sum(member.size for member in members) > MAX_LIVE_BYTES
                    or not all(member.isfile() or member.isdir() for member in members)):
                raise tarfile.TarError("refused archive")
            tar.extractall(part, filter="data")
    except (OSError, tarfile.TarError):
        shutil.rmtree(part, ignore_errors=True)
        return False
    os.utime(part)
    live, old = run_dir / "live", run_dir / "live.old"
    shutil.rmtree(old, ignore_errors=True)
    if live.is_dir() and not live.is_symlink():
        live.rename(old)
    part.rename(live)
    shutil.rmtree(old, ignore_errors=True)
    return True


def latest_source(run_dir: Path) -> tuple[Path, Path | None]:
    """The last word on the night, and what dates it: the fetch, or a later pull from the VM."""
    fetched, live = run_dir / "lance-nuit.tgz", run_dir / "live"
    live_ok = live.is_dir() and not live.is_symlink()
    fetched_ok = fetched.is_file() and not fetched.is_symlink()
    if live_ok and (not fetched_ok or live.stat().st_mtime > fetched.stat().st_mtime):
        return live, live
    return run_dir, fetched if fetched_ok else None


def scan_tickets(records: list[dict]) -> list[tuple[str, dict]]:
    """Each ticket the night found, in the order found, with the latest scan's word on it."""
    entries: dict[str, dict] = {}
    for record in records:
        discovered = record.get("discovered")
        for ticket in discovered if isinstance(discovered, list) else []:
            if isinstance(ticket, str):
                entries.setdefault(ticket, {"state": "pending"})
        for ticket, entry in mapping(record.get("tickets")).items():
            if isinstance(entry, dict):
                entries[str(ticket)] = entry
    return [(ticket, entry) for ticket, entry in entries.items() if SAFE_NAME.match(ticket)]


def run_states(source: Path) -> list[dict]:
    items = source / "work-items"
    if items.is_symlink() or not items.is_dir():
        return []
    states = []
    for path in sorted(items.glob("*/runs/*/*/state.json"))[:MAX_LIVE_MEMBERS]:
        if path.parent.is_symlink():
            continue
        state = read_json(path)
        if isinstance(state, dict) and isinstance(state.get("runId"), str):
            states.append(state)
    return states


def ticket_run(ticket: str, entry: dict, states: list[dict]) -> dict | None:
    """The root run of a ticket: named by the scan once done, the latest one touched since it started otherwise."""
    run_id = entry.get("runId")
    if isinstance(run_id, str):
        return next((state for state in states if state["runId"] == run_id), None)
    if entry.get("state") != "running":
        return None
    started = entry.get("startedAt") if isinstance(entry.get("startedAt"), str) else ""
    mine = [state for state in states
            if state.get("ticket") == ticket and state.get("rootRunId", state["runId"]) == state["runId"]
            and str(state.get("updatedAt", "")) >= started]
    return max(mine, key=lambda state: str(state.get("updatedAt", "")), default=None)


def step_view(step: dict) -> dict:
    control = mapping(step.get("control"))
    return {
        "id": text(step.get("id"), 128),
        "status": text(step.get("status"), 32),
        "attempt": number(step.get("last_attempt")),
        "startedAt": text(step.get("started_at"), 40),
        "finishedAt": text(step.get("finished_at"), 40),
        "durationMs": number(control.get("duration_ms")),
        "costUsd": number(control.get("total_cost_usd")),
    }


def run_view(state: dict) -> dict:
    control = mapping(state.get("total_control"))
    stop = mapping(mapping(state.get("outcome")).get("stop"))
    steps = state.get("steps") if isinstance(state.get("steps"), list) else []
    return {
        "runId": text(state.get("runId"), 128),
        "pipeline": text(state.get("name"), 128),
        "status": text(state.get("status"), 32),
        "updatedAt": text(state.get("updatedAt"), 40),
        "durationMs": number(control.get("duration_ms")),
        "costUsd": number(control.get("total_cost_usd")),
        "stoppedReason": text(state.get("stopped_reason")),
        "stop": {
            "subject": text(stop.get("subject"), 128),
            "kind": text(stop.get("kind"), 64),
            "detail": text(stop.get("detail")),
        } if stop else None,
        "steps": [step_view(step) for step in steps[:200] if isinstance(step, dict) and isinstance(step.get("id"), str)],
    }


def night_phase(run_dir: Path) -> dict | None:
    path = run_dir / "phase"
    if path.is_symlink() or not path.is_file():
        return None
    name = path.read_text()[:64].strip()
    return {"name": name, "since": mtime_iso(path)} if name in NIGHT_PHASES else None


def live(run_dir: Path) -> dict:
    source, dated_by = latest_source(run_dir)
    states = run_states(source)
    result = read_json(run_dir / "result.json")
    result = result if isinstance(result, dict) else None
    return {
        "format": LIVE_FORMAT,
        "night": run_dir.name,
        "writtenAt": iso_now(),
        "contactAt": None if dated_by is None else mtime_iso(dated_by),
        "phase": night_phase(run_dir),
        "phasesDone": [
            {"name": name, "at": text((run_dir / "phases" / name).read_text().strip(), 40)}
            for name in NIGHT_PHASES if (run_dir / "phases" / name).is_file()
        ],
        "result": None if result is None else {
            "state": text(result.get("state"), 16),
            "reason": text(result.get("reason")),
            "at": text(result.get("at"), 40),
        },
        "tickets": [
            {
                "ticket": ticket,
                "state": text(entry.get("state"), 32),
                "outcome": text(entry.get("outcome"), 64),
                "run": None if (state := ticket_run(ticket, entry, states)) is None else run_view(state),
            }
            for ticket, entry in scan_tickets(scan_records(source))
        ],
    }


def write_live(run_dir: Path, archive: Path | None) -> None:
    if archive is not None:
        unpack_live(run_dir, archive)
    part = run_dir / "live.json.part"
    part.write_text(json.dumps(live(run_dir), ensure_ascii=False) + "\n")
    os.replace(part, run_dir / "live.json")


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
        phase = night_phase(run_dir)
        state = f"running ({phase['name'] if phase else 'starting'})"
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
    if argv and argv[0] == "live" and len(argv) in (2, 3):
        write_live(Path(argv[1]), Path(argv[2]) if len(argv) == 3 else None)
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
