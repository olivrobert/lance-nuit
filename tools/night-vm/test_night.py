"""Offline checks of night.sh: fake incus and systemd, real git and broker."""

import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import tarfile
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("night_report", HERE / "night_report.py")
night_report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(night_report)

FAKE_INCUS = r'''#!/usr/bin/env python3
import json, os, shutil, sys
from pathlib import Path
args = sys.argv[1:]
with open(os.environ["CALL_LOG"], "a") as log:
    log.write(" ".join(args) + "\n")
state = Path(os.environ["INCUS_STATE"])
exists, started = state / "vm", state / "started"
line = " ".join(args)
def device(name):
    return state / f"device-{name}"
if args[0] == "copy":
    exists.touch()
elif args[0] == "delete":
    exists.unlink(missing_ok=True); started.unlink(missing_ok=True)
elif args[0] == "start":
    started.touch()
elif args[0] == "stop":
    started.unlink(missing_ok=True)
elif args[0] in ("info", "query"):
    if not exists.exists():
        sys.exit(1)
    print(json.dumps({"status": "Running" if started.exists() else "Stopped"}))
elif args[:2] == ["config", "show"]:
    print("devices:\n  eth0:\n    network: incusbr0\n    type: nic")
elif args[:3] == ["config", "device", "get"]:
    sys.exit(0 if device(args[4]).exists() else 1)
elif args[:3] == ["config", "device", "add"]:
    device(args[4]).touch()
elif args[:3] == ["config", "device", "remove"]:
    device(args[4]).unlink(missing_ok=True)
elif args[:2] == ["file", "pull"]:
    source = Path(os.environ.get("FETCH_DIR", "/nonexistent")) / Path(args[2]).name
    if not source.exists():
        sys.exit(1)
    shutil.copy(source, args[3])
elif args[0] == "exec":
    if not started.exists():
        sys.exit(1)
    if "vm-prepare.sh" in line:
        sys.exit(int(os.environ.get("PREPARE_EXIT", "0")))
    if "systemctl show" in line:
        print("SubState=" + os.environ.get("VM_UNIT_SUB", "exited"))
        print("Result=" + os.environ.get("VM_UNIT_RESULT", "success"))
        print("ExecMainStatus=" + os.environ.get("VM_UNIT_STATUS", "0"))
if not sys.stdin.isatty():
    sys.stdin.read()
'''


class NightTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "calls"
        self.state = self.root / "incus-state"
        self.state.mkdir()
        self.home = self.root / "home"
        self.secrets = self.root / "shm"
        self.secrets.mkdir()
        self.token = self.root / "claude-oauth-token"
        self.token.write_text("sk-ant-oat-fixture\n")
        self.token.chmod(0o600)
        self.gh_token = self.root / "gh-broker-token"
        self.gh_token.write_text("github_pat_fixture\n")
        self.gh_token.chmod(0o600)
        self.env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}", CALL_LOG=str(self.log),
                        INCUS_STATE=str(self.state), PIPELINE_HOME=str(self.home),
                        NIGHT_TOKEN_FILE=str(self.token), NIGHT_GH_TOKEN_FILE=str(self.gh_token),
                        NIGHT_SECRETS_ROOT=str(self.secrets),
                        NIGHT_GATEWAY="127.0.0.1", NIGHT_POLL_SECONDS="0",
                        GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1")
        self.executable("incus", FAKE_INCUS)
        self.executable("gh", '#!/bin/sh\nexit "${AUTH_EXIT:-0}"\n')
        self.executable("loginctl", "#!/bin/sh\necho yes\n")
        self.executable("systemd-inhibit", "#!/bin/sh\nexit 0\n")
        self.executable("systemd-run", '#!/bin/sh\nprintf "systemd-run %s\\n" "$*" >> "$CALL_LOG"\n')
        self.executable("systemctl", '#!/bin/sh\nexit "${HOST_UNIT_EXIT:-3}"\n')
        self.project = self.make_project()

    def executable(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o755)

    def git(self, *args, cwd=None):
        return subprocess.run(["git", *args], cwd=cwd or self.project, env=self.env, check=True,
                              capture_output=True, text=True).stdout.strip()

    def make_project(self):
        origin = self.root / "origin.git"
        project = self.root / "hypnose"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True, env=self.env)
        subprocess.run(["git", "init", "-q", "-b", "main", str(project)], check=True, env=self.env)
        (project / ".lance-nuit/pipelines").mkdir(parents=True)
        (project / ".lance-nuit/pipelines/claude.ts").write_text("export default {};\n")
        (project / ".lance-nuit/vm-prepare.sh").write_text("#!/bin/sh\n")
        (project / ".lance-nuit/config.json").write_text(json.dumps(
            {"baseBranch": "main", "workItem": {"project": "owner/hypnose"}}))
        self.project = project
        self.git("add", "-A")
        self.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
        self.git("remote", "add", "origin", str(origin))
        self.git("push", "-q", "origin", "main")
        return project

    def night(self, *args, **environment):
        return subprocess.run(["bash", str(HERE / "night.sh"), *args], env=dict(self.env, **environment),
                              input="", text=True, capture_output=True, timeout=60)

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def index(self, prefix):
        return next(i for i, call in enumerate(self.calls()) if call.startswith(prefix))

    def make_run(self, run_id="hypnose-20261114-213000", phases=()):
        run_dir = self.home / "night-runs" / run_id
        (run_dir / "phases").mkdir(parents=True)
        (run_dir / "run.env").write_text(
            f"PROJECT={self.project}\nPIPELINE=claude\nBASE=main\nREPO=owner/hypnose\n")
        for phase in phases:
            (run_dir / "phases" / phase).write_text("")
        return run_id, run_dir

    def fetched(self, scan_tickets):
        fetch = self.root / "fetch"
        (fetch / "pipeline-history/scans").mkdir(parents=True)
        (fetch / "pipeline-history/scans/20261114T213500000Z-claude-1.json").write_text(json.dumps(
            {"project": "owner/hypnose", "finishedAt": "2026-11-14T22:00:00Z", "abort": None,
             "tickets": scan_tickets}))
        with tarfile.open(fetch / "lance-nuit.tgz", "w:gz") as archive:
            archive.add(fetch / "pipeline-history", arcname="pipeline-history")
        return str(fetch)

    # -- start --------------------------------------------------------------

    def test_start_refuses_a_token_others_can_read(self):
        self.token.chmod(0o644)
        result = self.night("start", "--project", str(self.project), "--pipeline", "claude")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("mode 644", result.stderr)
        self.assertEqual(self.calls(), [])
        self.assertFalse((self.home / "night-runs").exists())

    def test_start_refuses_a_night_without_the_broker_token(self):
        self.gh_token.unlink()
        result = self.night("start", "--project", str(self.project), "--pipeline", "claude")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no GitHub token for the broker", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_the_broker_token_never_reaches_the_vm(self):
        run_id, _ = self.make_run()
        self.night("_run", run_id, FETCH_DIR=self.fetched({}))
        self.assertNotIn("github_pat_fixture", "\n".join(self.calls()))

    def test_start_refuses_a_base_branch_github_does_not_have(self):
        (self.project / "README").write_text("local only\n")
        self.git("add", "-A")
        self.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "unpushed")
        result = self.night("start", "--project", str(self.project), "--pipeline", "claude")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not pushed", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_start_refuses_a_pipeline_the_base_branch_does_not_carry(self):
        result = self.night("start", "--project", str(self.project), "--pipeline", "codex")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(".lance-nuit/pipelines/codex.ts is not committed on main", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_start_hands_the_night_to_a_user_unit_that_blocks_sleep(self):
        result = self.night("start", "--project", str(self.project), "--pipeline", "claude")
        self.assertEqual(result.returncode, 0, result.stderr)
        [launch] = self.calls()
        run_id = launch.split("--unit nuit-", 1)[1].split()[0]
        self.assertRegex(run_id, r"^hypnose-\d{8}-\d{6}$")
        self.assertIn("--user", launch)
        self.assertRegex(launch, r"systemd-inhibit --what=sleep .*/night\.sh _run " + run_id + "$")
        run_env = (self.home / "night-runs" / run_id / "run.env").read_text()
        self.assertIn("REPO=owner/hypnose", run_env)
        self.assertIn("PIPELINE=claude", run_env)

    # -- the unit -----------------------------------------------------------

    def test_acl_and_token_are_in_place_before_the_first_boot(self):
        run_id, run_dir = self.make_run()
        result = self.night("_run", run_id, FETCH_DIR=self.fetched({}))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        vm = f"nuit-{run_id}"
        self.assertLess(self.index(f"copy nuit-template/clean {vm}"), self.index(f"config device add {vm} eth0 nic network=nuitbr0"))
        self.assertLess(self.index(f"config device add {vm} eth0"), self.index(f"start {vm}"))
        secrets = self.index(f"config device add {vm} secrets disk source={self.secrets}/nuit-{run_id}")
        self.assertLess(secrets, self.index(f"start {vm}"))
        self.assertIn("readonly=true", self.calls()[secrets])

    def test_the_vm_run_gets_the_token_as_a_credential_and_a_time_limit(self):
        run_id, _ = self.make_run()
        self.night("_run", run_id, FETCH_DIR=self.fetched({}))
        [unit] = [call for call in self.calls() if " -- systemd-run " in call]
        self.assertIn("--uid nuit", unit)
        self.assertIn("--property=RuntimeMaxSec=7h", unit)
        self.assertIn("--property=LoadCredential=claude:/mnt/nuit-secrets/claude-oauth-token", unit)
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", "\n".join(self.calls()))
        self.assertNotIn("sk-ant-oat-fixture", "\n".join(self.calls()))

    def test_the_agent_can_commit_in_the_project_clone(self):
        run_id, _ = self.make_run()
        self.night("_run", run_id, FETCH_DIR=self.fetched({}))
        calls = "\n".join(self.calls())
        self.assertLess(calls.index("git clone"), calls.index("config user.name lance-nuit"))
        self.assertIn("config user.email", calls)

    def test_a_passed_run_deletes_the_vm_and_the_token(self):
        run_id, run_dir = self.make_run()
        result = self.night("_run", run_id, FETCH_DIR=self.fetched({}))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads((run_dir / "result.json").read_text())["state"], "passed")
        self.assertIn(f"delete nuit-{run_id} --force", self.calls())
        self.assertEqual(list(self.secrets.iterdir()), [])
        self.assertTrue((run_dir / "pipeline-history/scans").is_dir())

    def test_a_failed_run_keeps_the_vm_stopped_without_its_token(self):
        run_id, run_dir = self.make_run()
        result = self.night("_run", run_id, FETCH_DIR=self.fetched({"18": {"state": "done", "outcome": "failed"}}),
                            VM_UNIT_RESULT="exit-code", VM_UNIT_STATUS="1")
        self.assertNotEqual(result.returncode, 0)
        outcome = json.loads((run_dir / "result.json").read_text())
        self.assertEqual(outcome["state"], "failed")
        self.assertIn("the VM run exited 1", outcome["reason"])
        self.assertFalse(any(call.startswith("delete") for call in self.calls()))
        self.assertLess(self.index(f"stop nuit-{run_id}"), self.index(f"config device remove nuit-{run_id} secrets"))
        self.assertEqual(list(self.secrets.iterdir()), [])

    def test_a_failed_preparation_stops_the_night_before_the_agent(self):
        run_id, run_dir = self.make_run()
        result = self.night("_run", run_id, PREPARE_EXIT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(" -- systemd-run " in call for call in self.calls()))
        self.assertEqual(json.loads((run_dir / "result.json").read_text())["reason"], "phase prepare failed")
        self.assertFalse(any(call.startswith("delete") for call in self.calls()))

    def test_the_time_limit_reads_as_a_cut_night(self):
        run_id, run_dir = self.make_run()
        self.night("_run", run_id, FETCH_DIR=self.fetched({"18": {"state": "running"}}),
                   VM_UNIT_SUB="failed", VM_UNIT_RESULT="timeout", VM_UNIT_STATUS="143")
        self.assertEqual(json.loads((run_dir / "result.json").read_text())["state"], "cut")

    def test_resume_skips_the_phases_already_marked(self):
        run_id, _ = self.make_run(phases=("vm", "code"))
        (self.state / "vm").touch()
        self.night("_run", run_id, FETCH_DIR=self.fetched({}))
        self.assertFalse(any(call.startswith("copy") for call in self.calls()))
        self.assertFalse(any("in.bundle" in call for call in self.calls()))
        self.assertTrue(any(call.startswith(f"config device add nuit-{run_id} secrets") for call in self.calls()))
        self.assertTrue(any("vm-prepare.sh" in call for call in self.calls()))

    def test_resume_passes_the_replay_flag_to_the_vm_run(self):
        run_id, run_dir = self.make_run(phases=("vm", "code"))
        result_file = run_dir / "result.json"
        result_file.write_text("{}")
        self.night("resume", run_id, "--replay-interrupted")
        self.assertFalse(result_file.exists())
        [launch] = self.calls()
        self.assertTrue(launch.endswith(f"_run {run_id} --replay-interrupted"), launch)

    def test_the_broker_dies_with_the_unit(self):
        run_id, run_dir = self.make_run()
        self.night("_run", run_id, FETCH_DIR=self.fetched({}))
        port = int((run_dir / "broker.port").read_text())
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", port))
        self.assertTrue((run_dir / "gh-broker.log").exists())

    # -- clean --------------------------------------------------------------

    def test_clean_refuses_a_running_night(self):
        run_id, _ = self.make_run()
        result = self.night("clean", run_id, HOST_UNIT_EXIT="0")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_clean_deletes_the_vm_and_keeps_the_run_dir(self):
        run_id, run_dir = self.make_run()
        (self.state / "vm").touch()
        result = self.night("clean", run_id)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"delete nuit-{run_id} --force", self.calls())
        self.assertTrue((run_dir / "run.env").exists())

    def test_a_run_id_cannot_leave_the_runs_directory(self):
        result = self.night("clean", "../../etc")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid run id", result.stderr)


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.run_dir = Path(self.directory.name)
        (self.run_dir / "pipeline-history/scans").mkdir(parents=True)
        (self.run_dir / "phases").mkdir()

    def scan(self, name, tickets, finished=True):
        (self.run_dir / "pipeline-history/scans" / name).write_text(json.dumps(
            {"finishedAt": "2026-11-15T03:00:00Z" if finished else None, "abort": None, "tickets": tickets}))

    def test_a_resumed_scan_has_the_last_word_on_a_ticket(self):
        self.scan("1.json", {"18": {"state": "running"}}, finished=False)
        self.scan("2.json", {"18": {"state": "done", "outcome": "fixed"}})
        (self.run_dir / "phases/bundle-verified").write_text("")
        self.assertEqual(night_report.classify(self.run_dir, "", "success", "0", "0"), ("passed", "#18 fixed"))

    def test_an_escalated_ticket_keeps_the_vm(self):
        self.scan("1.json", {"18": {"state": "done", "outcome": "escalated"}})
        self.assertEqual(night_report.classify(self.run_dir, "", "success", "0", "0"), ("failed", "#18 escalated"))

    def test_a_fixed_ticket_needs_a_verified_bundle(self):
        self.scan("1.json", {"18": {"state": "done", "outcome": "fixed"}})
        self.assertEqual(night_report.classify(self.run_dir, "", "success", "0", "0")[0], "failed")

    def test_cost_counts_root_runs_once_at_their_latest_line(self):
        lines = [
            {"runId": "a", "costUsd": 1.0},
            {"runId": "a", "costUsd": 2.5},
            {"runId": "b", "parentRunId": "a", "costUsd": 9.0},
            {"runId": "c", "costUsd": 0.5},
        ]
        (self.run_dir / "pipeline-history/runs.jsonl").write_text("\n".join(map(json.dumps, lines)) + "\nnot json\n")
        self.assertEqual(night_report.cost_usd(self.run_dir), 3.0)


if __name__ == "__main__":
    unittest.main()
