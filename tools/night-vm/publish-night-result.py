#!/usr/bin/env python3
"""Host-side publisher: turns the bundle a night VM brought back into draft PRs.

The bundle is untrusted. It is imported into a bare repository of its own, never
into a working clone, and nothing from it is checked out or executed. A
`nuit/<ticket>` branch is pushed only when its ticket ended `fixed` in a scan
record, it descends from the base branch, it stays within size bounds, and it
touches no path that runs code on push or on a later checkout. The forge
credential is the host's `gh` one; the VM never holds it.

Usage: publish-night-result.py <run-id> --repo owner/name [--base main]
                               [--dry-run] [--runs-dir DIR] [limits...]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

RUN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
BRANCH_REF = re.compile(r"refs/heads/nuit/([1-9][0-9]{0,8})")
SHA = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")

MAX_SCAN_BYTES = 1024 * 1024
MAX_HEADER_BYTES = 64 * 1024

PROTECTED_PREFIXES = (
    ".github/", ".lance-nuit/", ".claude/", ".codex/", ".opencode/",
    ".husky/", ".githooks/", ".git-hooks/", ".vscode/", ".idea/",
)
PROTECTED_FILES = {
    ".gitmodules", ".mcp.json", ".envrc", ".pre-commit-config.yaml",
    "lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml",
    "lefthook-local.yml", "lefthook-local.yaml",
}
PROTECTED_NAMES = {"claude.md", "claude.local.md", "agents.md"}


class Refused(Exception):
    """The run as a whole does not meet the contract: nothing is published."""


@dataclass
class Branch:
    ticket: str
    tip: str
    verdict: str = "pending"
    reason: str = ""
    base: str = ""
    commits: list[str] = field(default_factory=list)
    numstat: list[tuple[str, str, str]] = field(default_factory=list)
    pr: str = ""


def protected(path: str) -> bool:
    lowered = path.lower()
    return (
        lowered in PROTECTED_FILES
        or lowered.startswith(PROTECTED_PREFIXES)
        or lowered.rsplit("/", 1)[-1] in PROTECTED_NAMES
    )


class Git:
    def __init__(self, repo: Path, remote: str):
        self.repo = repo
        self.remote = remote
        self.env = {
            key: value for key, value in os.environ.items() if not key.startswith("GIT_")
        } | {
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_TERMINAL_PROMPT": "0",
        }

    def run(self, *args: str, remote: bool = False, input: str | None = None) -> str:
        options = ["-c", "core.hooksPath=/dev/null"]
        if remote:
            options += ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]
        completed = subprocess.run(
            ["git", *options, "-C", str(self.repo), *args],
            env=self.env, input=input, capture_output=True, text=True, timeout=600, check=False,
        )
        if completed.returncode != 0:
            raise GitError(args[0], completed.stderr.strip())
        return completed.stdout


class GitError(Exception):
    def __init__(self, command: str, stderr: str):
        super().__init__(f"git {command}: {' '.join(stderr.splitlines()[-2:]) or 'failed'}")


def gh(*args: str, input: str | None = None, cwd: Path) -> str:
    completed = subprocess.run(
        ["gh", *args], input=input, capture_output=True, text=True, timeout=120,
        check=False, cwd=cwd,
    )
    if completed.returncode != 0:
        raise GhError(f"gh {' '.join(args[:2])}: {completed.stderr.strip() or completed.returncode}")
    return completed.stdout


class GhError(Exception):
    pass


def freeze_bundle(source: Path, target: Path, limit: int) -> None:
    try:
        descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as error:
        raise Refused(f"cannot open {source.name} without following links: {error.strerror}")
    with os.fdopen(descriptor, "rb") as reader:
        info = os.fstat(reader.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise Refused(f"{source.name} is not a regular file")
        data = reader.read(limit + 1)
    if len(data) > limit:
        raise Refused(f"{source.name} exceeds {limit} bytes")
    target.write_bytes(data)


def bundle_header(bundle: Path) -> tuple[list[str], dict[str, str]]:
    with bundle.open("rb") as reader:
        raw = reader.read(MAX_HEADER_BYTES)
    end = raw.find(b"\n\n")
    if end < 0:
        raise Refused("bundle header is missing or oversized")
    lines = raw[:end].decode("ascii", "strict").split("\n")
    if lines[0] not in ("# v2 git bundle", "# v3 git bundle"):
        raise Refused("not a git bundle")
    prerequisites, refs = [], {}
    for line in lines[1:]:
        if line.startswith("@"):
            continue
        if line.startswith("-"):
            sha = line[1:].split(" ", 1)[0]
            if not SHA.fullmatch(sha):
                raise Refused("malformed bundle prerequisite")
            prerequisites.append(sha)
            continue
        sha, _, ref = line.partition(" ")
        match = BRANCH_REF.fullmatch(ref)
        if not SHA.fullmatch(sha) or not match:
            raise Refused(f"unexpected ref in bundle: {ref[:80]!r}")
        refs[match.group(1)] = sha
    if not refs:
        raise Refused("bundle carries no nuit/<ticket> branch")
    return prerequisites, refs


def scan_outcomes(scans: Path, repo: str) -> dict[str, str]:
    settled: dict[str, str] = {}
    if not scans.is_dir() or scans.is_symlink():
        return settled
    for path in sorted(scans.glob("*.json")):
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_SCAN_BYTES:
            continue
        try:
            record = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(record, dict) or record.get("project") != repo:
            continue
        tickets = record.get("tickets")
        if not isinstance(tickets, dict):
            continue
        for ticket, entry in tickets.items():
            if isinstance(entry, dict) and entry.get("state") == "done":
                settled[str(ticket)] = str(entry.get("outcome"))[:40]
    return settled


def inspect(git: Git, branch: Branch, base_ref: str, opts: argparse.Namespace) -> None:
    try:
        branch.base = git.run("merge-base", base_ref, branch.tip).strip()
    except GitError:
        branch.verdict, branch.reason = "refused", "no common history with the base branch"
        return
    span = f"{branch.base}..{branch.tip}"
    branch.commits = git.run("log", "--format=%h %s", span).splitlines()
    if not branch.commits:
        branch.verdict, branch.reason = "refused", "no commit above the base branch"
        return
    if len(branch.commits) > opts.max_commits:
        branch.verdict, branch.reason = "refused", f"{len(branch.commits)} commits exceed {opts.max_commits}"
        return
    if git.run("rev-list", "--merges", span).strip():
        branch.verdict, branch.reason = "refused", "merge commits are not published"
        return
    touched = {path for path in git.run("log", "--format=", "--name-only", "--no-renames", "-z", span).split("\0") if path}
    touched |= {path for path in git.run("diff", "--name-only", "--no-renames", "-z", branch.base, branch.tip).split("\0") if path}
    denied = sorted(path for path in touched if protected(path))
    if denied:
        branch.verdict, branch.reason = "refused", "touches protected paths: " + ", ".join(denied[:10])
        return
    raw = git.run("diff", "--raw", "--no-renames", "-z", branch.base, branch.tip).split("\0")
    if any(entry.startswith(":") and "160000" in entry[1:].split(" ")[:2] for entry in raw):
        branch.verdict, branch.reason = "refused", "adds or changes a submodule"
        return
    fields = git.run("diff", "--numstat", "--no-renames", "-z", branch.base, branch.tip).split("\0")
    branch.numstat = [tuple(entry.split("\t", 2)) for entry in fields if entry.count("\t") == 2]
    if len(branch.numstat) > opts.max_files:
        branch.verdict, branch.reason = "refused", f"{len(branch.numstat)} files exceed {opts.max_files}"
        return
    lines = sum(int(a) + int(d) for a, d, _ in branch.numstat if a.isdigit() and d.isdigit())
    if lines > opts.max_lines:
        branch.verdict, branch.reason = "refused", f"{lines} changed lines exceed {opts.max_lines}"
        return
    branch.verdict = "accepted"


def fenced(lines: list[str]) -> str:
    text = "\n".join(lines)
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    fence = "`" * max(3, longest + 1)
    return f"{fence}text\n{text}\n{fence}"


def pr_body(branch: Branch, run_id: str) -> str:
    files = [f"{added:>6} {deleted:>6}  {path}" for added, deleted, path in branch.numstat]
    return "\n\n".join([
        f"Closes #{branch.ticket}",
        f"Published from night run `{run_id}`, commit `{branch.tip}`. "
        "The code was written unattended: review it here before checking it out.",
        "### Commits",
        fenced(branch.commits[:100]),
        "### Files (added, deleted)",
        fenced(files[:300]),
    ])


def publish(git: Git, branch: Branch, opts: argparse.Namespace, work: Path) -> None:
    ref = f"refs/heads/nuit/{branch.ticket}"
    listed = git.run("ls-remote", git.remote, ref, remote=True).split()
    remote_tip = listed[0] if listed else ""
    if remote_tip and remote_tip != branch.tip:
        branch.verdict, branch.reason = "refused", f"remote branch exists at {remote_tip[:12]}"
        return
    if not remote_tip:
        git.run("push", "--no-verify", git.remote, f"{branch.tip}:{ref}", remote=True)

    head = f"nuit/{branch.ticket}"
    existing = json.loads(gh("pr", "list", "--repo", opts.repo, "--head", head, "--state", "all",
                             "--json", "url,headRefOid", cwd=work) or "[]")
    if existing:
        branch.verdict, branch.pr = "published", existing[0]["url"]
        return
    try:
        title = json.loads(gh("issue", "view", branch.ticket, "--repo", opts.repo,
                              "--json", "title", cwd=work))["title"].strip()
    except (GhError, ValueError, KeyError, AttributeError):
        title = ""
    title = title or f"Ticket #{branch.ticket}"
    output = gh("pr", "create", "--repo", opts.repo, "--base", opts.base, "--head", head,
                "--draft", "--title", title, "--body-file", "-",
                input=pr_body(branch, opts.run_id), cwd=work)
    branch.verdict, branch.pr = "published", output.strip().splitlines()[-1] if output.strip() else ""


def journal(path: Path, opts: argparse.Namespace, branch: Branch | None, verdict: str, reason: str = "") -> None:
    entry = {
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "run": opts.run_id,
        "repo": opts.repo,
        "verdict": verdict,
    }
    if branch:
        entry |= {"ticket": branch.ticket, "commit": branch.tip, "ref": f"refs/heads/nuit/{branch.ticket}"}
        if branch.pr:
            entry["pr"] = branch.pr
    if reason:
        entry["reason"] = reason
    with path.open("a") as writer:
        writer.write(json.dumps(entry) + "\n")


def prepare(opts: argparse.Namespace, run_dir: Path) -> tuple[Git, list[Branch], str]:
    work = run_dir / "publish"
    if work.is_symlink():
        raise Refused("publish/ must not be a link")
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(mode=0o700)
    bundle = work / "out.bundle"
    freeze_bundle(run_dir / "out.bundle", bundle, opts.max_bundle_bytes)
    prerequisites, refs = bundle_header(bundle)

    repo = work / "repo.git"
    subprocess.run(["git", "init", "--bare", "--quiet", "--template=", str(repo)],
                   check=True, env={k: v for k, v in os.environ.items() if not k.startswith("GIT_")})
    git = Git(repo, opts.remote_url or f"https://github.com/{opts.repo}.git")
    for key, value in (("transfer.fsckObjects", "true"), ("fetch.fsckObjects", "true"),
                       ("core.hooksPath", "/dev/null")):
        git.run("config", key, value)

    base_ref = f"refs/remotes/origin/{opts.base}"
    git.run("fetch", "--quiet", "--no-tags", git.remote, f"+refs/heads/{opts.base}:{base_ref}", remote=True)
    try:
        git.run("bundle", "verify", str(bundle))
    except GitError as error:
        raise Refused(f"bundle does not apply to {opts.base} on the forge: {error}")
    for sha in prerequisites:
        try:
            git.run("merge-base", "--is-ancestor", sha, base_ref)
        except GitError:
            raise Refused(f"bundle prerequisite {sha[:12]} is not on {opts.base}")
    refspecs = [f"refs/heads/nuit/{ticket}:refs/night/{ticket}" for ticket in sorted(refs)]
    try:
        git.run("fetch", "--quiet", "--no-tags", str(bundle), *refspecs)
        git.run("fsck", "--strict", "--no-dangling", "--no-progress")
    except GitError as error:
        raise Refused(f"bundle objects rejected: {error}")
    branches = [Branch(ticket, git.run("rev-parse", f"refs/night/{ticket}").strip())
                for ticket in sorted(refs, key=int)]
    return git, branches, base_ref


def parse(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Publish the nuit/<ticket> branches of a night run as draft PRs.")
    parser.add_argument("run_id")
    parser.add_argument("--repo", required=True, help="owner/name of the GitHub repository")
    parser.add_argument("--base", default="main")
    parser.add_argument("--runs-dir", type=Path, default=Path.home() / ".lance-nuit/night-runs")
    parser.add_argument("--dry-run", action="store_true", help="validate only: no push, no PR")
    parser.add_argument("--remote-url", help=argparse.SUPPRESS)
    parser.add_argument("--max-bundle-bytes", type=int, default=20 * 1024 * 1024)
    parser.add_argument("--max-commits", type=int, default=50)
    parser.add_argument("--max-files", type=int, default=200)
    parser.add_argument("--max-lines", type=int, default=20000)
    opts = parser.parse_args(argv)
    if not RUN_ID.fullmatch(opts.run_id):
        parser.error("invalid run id")
    if not REPO.fullmatch(opts.repo):
        parser.error("--repo must be owner/name")
    if subprocess.run(["git", "check-ref-format", "--branch", opts.base], capture_output=True).returncode:
        parser.error("invalid --base")
    return opts


def main(argv: list[str]) -> int:
    opts = parse(argv)
    run_dir = opts.runs_dir / opts.run_id
    if run_dir.is_symlink() or not run_dir.is_dir():
        print(f"no run directory {run_dir}", file=sys.stderr)
        return 2
    log = run_dir / "publish.jsonl"
    try:
        git, branches, base_ref = prepare(opts, run_dir)
    except (Refused, GitError) as error:
        journal(log, opts, None, "refused", str(error))
        print(f"REFUSED  {error}", file=sys.stderr)
        return 1

    outcomes = scan_outcomes(run_dir / "pipeline-history" / "scans", opts.repo)
    for branch in branches:
        outcome = outcomes.get(branch.ticket)
        if outcome != "fixed":
            branch.verdict = "skipped"
            branch.reason = f"scan outcome is {outcome}" if outcome else "ticket settled in no scan record"
            continue
        inspect(git, branch, base_ref, opts)
        if branch.verdict == "accepted" and not opts.dry_run:
            try:
                publish(git, branch, opts, run_dir / "publish")
            except (GitError, GhError, ValueError) as error:
                branch.verdict, branch.reason = "failed", str(error)

    for branch in branches:
        journal(log, opts, branch, branch.verdict, branch.reason)
        detail = branch.pr or branch.reason
        print(f"{branch.verdict.upper():<9} nuit/{branch.ticket} {branch.tip[:12]}  {detail}".rstrip())
    if any(branch.verdict in ("refused", "failed") for branch in branches):
        print(f"inspect without checkout: git -C {git.repo} show --stat refs/night/<ticket>", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
