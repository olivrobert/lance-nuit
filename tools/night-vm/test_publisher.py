"""Offline checks of the publisher: real git repositories, a local bare stands in for GitHub, `gh` is faked."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
PUBLISHER = HERE / "publish-night-result.py"
RUN_ID = "20261114-0100"

FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys
path = os.environ["GH_STATE"]
state = json.load(open(path)) if os.path.exists(path) else {"prs": [], "calls": []}
args = sys.argv[1:]
state["calls"].append(args)
output, code = "", 0
if args[:2] == ["pr", "list"]:
    head = args[args.index("--head") + 1]
    output = json.dumps([pr for pr in state["prs"] if pr["head"] == head])
elif args[:2] == ["pr", "create"]:
    if os.environ.get("PR_CREATE_EXIT"):
        code = int(os.environ["PR_CREATE_EXIT"])
    else:
        url = f"https://github.com/owner/repo/pull/{len(state['prs']) + 1}"
        state["prs"].append({"head": args[args.index("--head") + 1], "url": url,
                             "title": args[args.index("--title") + 1], "body": sys.stdin.read(),
                             "draft": "--draft" in args, "base": args[args.index("--base") + 1]})
        output = url + "\n"
elif args[:2] == ["issue", "view"]:
    output = json.dumps({"title": f"Issue {args[2]} title"})
json.dump(state, open(path, "w"))
sys.stdout.write(output)
sys.exit(code)
'''


class PublisherTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        (bin_dir / "gh").write_text(FAKE_GH)
        (bin_dir / "gh").chmod(0o755)
        self.state = self.root / "gh-state.json"
        self.env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")} | {
            "PATH": f"{bin_dir}:{os.environ['PATH']}", "GH_STATE": str(self.state),
            "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "nuit", "GIT_AUTHOR_EMAIL": "nuit@vm", "GIT_COMMITTER_NAME": "nuit",
            "GIT_COMMITTER_EMAIL": "nuit@vm",
        }
        self.origin = self.root / "origin.git"
        self.vm = self.root / "vm"
        self.git("init", "--quiet", "--bare", "--initial-branch=main", str(self.origin))
        self.git("init", "--quiet", "--initial-branch=main", str(self.vm))
        self.write("README.md", "hello\n")
        self.write(".github/workflows/ci.yml", "on: push\n")
        self.git("-C", str(self.vm), "add", "-A")
        self.git("-C", str(self.vm), "commit", "--quiet", "-m", "base")
        self.git("-C", str(self.vm), "push", "--quiet", str(self.origin), "main")
        self.run_dir = self.root / "runs" / RUN_ID
        self.run_dir.mkdir(parents=True)
        self.outcomes = {}

    def git(self, *args):
        return subprocess.run(["git", *args], env=self.env, check=True, capture_output=True, text=True).stdout

    def vm_git(self, *args):
        return self.git("-C", str(self.vm), *args)

    def write(self, path, content):
        target = self.vm / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def branch(self, ticket, *changes, outcome="fixed"):
        self.vm_git("switch", "--quiet", "-C", f"nuit/{ticket}", "main")
        for message, files in changes:
            for path, content in files.items():
                if content is None:
                    self.vm_git("rm", "--quiet", path)
                else:
                    self.write(path, content)
            self.vm_git("add", "-A")
            self.vm_git("commit", "--quiet", "-m", message)
        self.vm_git("switch", "--quiet", "main")
        if outcome:
            self.outcomes[ticket] = outcome
        return self.vm_git("rev-parse", f"nuit/{ticket}").strip()

    def bring_back(self):
        self.vm_git("bundle", "create", "--quiet", str(self.run_dir / "out.bundle"), "--branches=nuit/*", "^main")
        scans = self.run_dir / "pipeline-history" / "scans"
        scans.mkdir(parents=True, exist_ok=True)
        tickets = {ticket: {"state": "done", "outcome": outcome} for ticket, outcome in self.outcomes.items()}
        (scans / "20261114T010000000Z-claude-abcd1234.json").write_text(
            json.dumps({"version": 1, "project": "owner/repo", "tickets": tickets}))

    def publish(self, *args, **environment):
        return subprocess.run(
            ["python3", "-I", str(PUBLISHER), RUN_ID, "--repo", "owner/repo",
             "--runs-dir", str(self.root / "runs"), "--remote-url", str(self.origin), *args],
            env=dict(self.env, **environment), capture_output=True, text=True, timeout=60)

    def remote_tip(self, ticket):
        listed = self.git("-C", str(self.origin), "for-each-ref", "--format=%(objectname)", f"refs/heads/nuit/{ticket}")
        return listed.strip()

    def gh_state(self):
        return json.loads(self.state.read_text()) if self.state.exists() else {"prs": [], "calls": []}

    def journal(self):
        return [json.loads(line) for line in (self.run_dir / "publish.jsonl").read_text().splitlines()]

    def test_fixed_branch_becomes_a_draft_pr_closing_its_ticket(self):
        tip = self.branch("19", ("fix: `rdv` slot @someone ```", {"src/a.php": "<?php\n"}))
        self.bring_back()
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.remote_tip("19"), tip)
        [pr] = self.gh_state()["prs"]
        self.assertEqual((pr["head"], pr["base"], pr["title"], pr["draft"]), ("nuit/19", "main", "Issue 19 title", True))
        self.assertTrue(pr["body"].startswith("Closes #19"))
        self.assertIn("src/a.php", pr["body"])
        self.assertIn("````text\n", pr["body"])
        self.assertEqual(self.journal()[-1] | {"at": None}, {
            "at": None, "run": RUN_ID, "repo": "owner/repo", "verdict": "published", "ticket": "19",
            "commit": tip, "ref": "refs/heads/nuit/19", "pr": pr["url"]})

    def test_rerun_neither_pushes_again_nor_duplicates_the_pr(self):
        self.branch("19", ("fix", {"src/a.php": "x\n"}))
        self.bring_back()
        self.assertEqual(self.publish().returncode, 0)
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.gh_state()["prs"]), 1)
        self.assertIn("PUBLISHED", result.stdout)

    def test_rerun_after_a_failed_pr_creation_only_creates_the_pr(self):
        tip = self.branch("19", ("fix", {"src/a.php": "x\n"}))
        self.bring_back()
        failed = self.publish(PR_CREATE_EXIT="1")
        self.assertEqual(failed.returncode, 1)
        self.assertEqual(self.remote_tip("19"), tip)
        self.assertEqual(self.gh_state()["prs"], [])
        self.assertEqual(self.publish().returncode, 0)
        self.assertEqual(len(self.gh_state()["prs"]), 1)

    def test_diverging_remote_branch_is_not_overwritten(self):
        self.branch("19", ("fix", {"src/a.php": "x\n"}))
        self.bring_back()
        other = self.branch("19", ("other", {"src/b.php": "y\n"}))
        self.vm_git("push", "--quiet", str(self.origin), "nuit/19")
        result = self.publish()
        self.assertEqual(result.returncode, 1)
        self.assertIn("remote branch exists", result.stdout)
        self.assertEqual(self.remote_tip("19"), other)
        self.assertEqual(self.gh_state()["prs"], [])

    def test_protected_paths_refuse_the_branch_but_not_its_neighbours(self):
        cases = {
            "21": ".github/workflows/x.yml", "22": ".gitmodules", "23": ".claude/settings.json",
            "24": ".lance-nuit/pipelines/claude.ts", "25": ".husky/pre-commit", "26": "docs/CLAUDE.md",
            "27": ".envrc", "28": ".mcp.json",
        }
        for ticket, path in cases.items():
            self.branch(ticket, ("sneaky", {path: "run me\n"}))
        clean = self.branch("30", ("fix", {"src/a.php": "x\n"}))
        self.bring_back()
        result = self.publish()
        self.assertEqual(result.returncode, 1)
        for ticket, path in cases.items():
            with self.subTest(path=path):
                self.assertEqual(self.remote_tip(ticket), "")
                self.assertIn(path, next(e["reason"] for e in self.journal() if e.get("ticket") == ticket))
        self.assertEqual(self.remote_tip("30"), clean)
        self.assertEqual([pr["head"] for pr in self.gh_state()["prs"]], ["nuit/30"])

    def test_protected_path_added_then_removed_is_still_refused(self):
        self.branch("19", ("add", {".github/workflows/x.yml": "on: push\n"}),
                    ("hide", {".github/workflows/x.yml": None}), ("fix", {"src/a.php": "x\n"}))
        self.bring_back()
        self.assertEqual(self.publish().returncode, 1)
        self.assertEqual(self.remote_tip("19"), "")

    def test_submodule_without_gitmodules_is_refused(self):
        self.vm_git("switch", "--quiet", "-c", "nuit/19", "main")
        self.vm_git("update-index", "--add", "--cacheinfo", f"160000,{self.vm_git('rev-parse', 'main').strip()},lib")
        self.vm_git("commit", "--quiet", "-m", "vendor")
        self.vm_git("switch", "--quiet", "main")
        self.outcomes["19"] = "fixed"
        self.bring_back()
        result = self.publish()
        self.assertIn("submodule", result.stdout)
        self.assertEqual(self.remote_tip("19"), "")

    def test_only_fixed_tickets_are_published(self):
        self.branch("19", ("fix", {"src/a.php": "x\n"}), outcome="escalated")
        self.branch("20", ("fix", {"src/b.php": "x\n"}), outcome=None)
        self.bring_back()
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.remote_tip("19"), self.remote_tip("20")), ("", ""))
        self.assertEqual(self.gh_state()["calls"], [])
        self.assertEqual({e["verdict"] for e in self.journal()}, {"skipped"})

    def test_scan_record_of_another_repository_does_not_count(self):
        self.branch("19", ("fix", {"src/a.php": "x\n"}))
        self.bring_back()
        self.publish("--dry-run")
        result = subprocess.run(
            ["python3", "-I", str(PUBLISHER), RUN_ID, "--repo", "owner/other",
             "--runs-dir", str(self.root / "runs"), "--remote-url", str(self.origin)],
            env=self.env, capture_output=True, text=True, timeout=60)
        self.assertIn("SKIPPED", result.stdout)
        self.assertEqual(self.remote_tip("19"), "")

    def test_dry_run_validates_without_writing_to_the_forge(self):
        self.branch("19", ("fix", {"src/a.php": "x\n"}))
        self.bring_back()
        result = self.publish("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ACCEPTED", result.stdout)
        self.assertEqual(self.remote_tip("19"), "")
        self.assertEqual(self.gh_state()["calls"], [])

    def test_unexpected_ref_refuses_the_whole_run(self):
        self.branch("19", ("fix", {"src/a.php": "x\n"}))
        self.vm_git("branch", "feature", "nuit/19")
        self.vm_git("bundle", "create", "--quiet", str(self.run_dir / "out.bundle"), "nuit/19", "feature", "^main")
        result = self.publish()
        self.assertEqual(result.returncode, 1)
        self.assertIn("unexpected ref", result.stderr)
        self.assertEqual(self.remote_tip("19"), "")

    def test_size_bounds(self):
        self.branch("19", ("fix", {"src/a.php": "x\n" * 50}))
        self.bring_back()
        bundle = self.publish("--max-bundle-bytes", "100")
        self.assertEqual(bundle.returncode, 1)
        self.assertIn("exceeds 100 bytes", bundle.stderr)
        lines = self.publish("--max-lines", "10")
        self.assertIn("50 changed lines exceed 10", lines.stdout)
        self.assertEqual(self.remote_tip("19"), "")

    def test_merge_commits_are_refused(self):
        self.branch("19", ("fix", {"src/a.php": "x\n"}))
        self.vm_git("switch", "--quiet", "-c", "side", "main")
        self.write("src/b.php", "y\n")
        self.vm_git("add", "-A")
        self.vm_git("commit", "--quiet", "-m", "side")
        self.vm_git("switch", "--quiet", "nuit/19")
        self.vm_git("merge", "--quiet", "--no-edit", "side")
        self.vm_git("switch", "--quiet", "main")
        self.bring_back()
        result = self.publish()
        self.assertIn("merge commits", result.stdout)
        self.assertEqual(self.remote_tip("19"), "")

    def test_linked_bundle_is_refused(self):
        self.branch("19", ("fix", {"src/a.php": "x\n"}))
        self.bring_back()
        real = self.run_dir / "real.bundle"
        (self.run_dir / "out.bundle").rename(real)
        (self.run_dir / "out.bundle").symlink_to(real)
        result = self.publish()
        self.assertEqual(result.returncode, 1)
        self.assertIn("without following links", result.stderr)

    def test_objects_failing_fsck_are_refused(self):
        blob = subprocess.run(["git", "-C", str(self.vm), "hash-object", "-w", "--stdin"], input="x\n",
                              env=self.env, check=True, capture_output=True, text=True).stdout.strip()
        tree = subprocess.run(["git", "-C", str(self.vm), "hash-object", "-w", "-t", "tree", "--literally", "--stdin"],
                              input=b"100644 .GIT\0" + bytes.fromhex(blob), env=self.env, check=True,
                              capture_output=True).stdout.decode().strip()
        commit = self.vm_git("commit-tree", tree, "-p", "main", "-m", "evil").strip()
        self.vm_git("branch", "nuit/19", commit)
        self.outcomes["19"] = "fixed"
        self.bring_back()
        result = self.publish()
        self.assertEqual(result.returncode, 1)
        self.assertIn("bundle objects rejected", result.stderr)
        self.assertEqual(self.remote_tip("19"), "")

    def test_bundle_built_on_another_history_is_refused(self):
        self.branch("19", ("fix", {"src/a.php": "x\n"}))
        self.bring_back()
        self.git("-C", str(self.origin), "update-ref", "refs/heads/main",
                 self.git("-C", str(self.origin), "commit-tree", "-m", "rewritten",
                          self.git("-C", str(self.origin), "rev-parse", "main^{tree}").strip()).strip())
        result = self.publish()
        self.assertEqual(result.returncode, 1)
        self.assertIn("bundle does not apply to main", result.stderr)
        self.assertEqual(self.remote_tip("19"), "")

    def test_invalid_run_id_is_rejected_before_any_access(self):
        result = subprocess.run(["python3", "-I", str(PUBLISHER), "../escape", "--repo", "owner/repo",
                                 "--runs-dir", str(self.root / "runs")], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.state.exists())


if __name__ == "__main__":
    unittest.main()
