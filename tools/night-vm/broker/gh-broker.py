#!/usr/bin/env python3
"""Host-side broker: runs a fixed, tiny set of `gh issue` commands for the night VM.

The VM has no credentials and no `gh` binary. It calls this broker through the
Incus bridge gateway; the broker runs the real `gh` with the host user's
credentials and returns stdout/stderr/exit code.

The whole point is that the VM gets *operations*, never the token. So the broker
never trusts what it receives:

  - only the five argument shapes the lance-nuit GitHub adapter actually emits
    are accepted, matched positionally;
  - `--repo` is imposed by the broker, and a `--repo` sent by the VM must match
    the allowed one or the request is refused;
  - every request is logged with its verdict.

Usage: gh-broker.py --repo owner/name --token-file PATH
                   [--host 10.174.226.1] [--port 8099]
"""

from __future__ import annotations

import argparse
import json
import secrets
import subprocess
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_BODY_BYTES = 256 * 1024
MAX_ARGS = 32

# Fields the adapter is allowed to ask for through `--json`.
JSON_FIELDS = {"title", "body", "state", "labels", "comments", "number"}


def _is_flag(value: str) -> bool:
    return value.startswith("-")


def _check_json_fields(spec: str) -> bool:
    parts = [p.strip() for p in spec.split(",")]
    return bool(parts) and all(p in JSON_FIELDS for p in parts)


def validate(args: list[str], repo: str) -> tuple[bool, str]:
    """Return (allowed, reason). Matches the five shapes the adapter emits."""
    if not args or len(args) > MAX_ARGS:
        return False, "empty or oversized argument list"
    if args[0] != "issue":
        return False, f"only `gh issue` is brokered, got `gh {args[0]}`"

    # Any --repo present must be the allowed one; the broker re-imposes it anyway.
    for i, a in enumerate(args):
        if a == "--repo":
            if i + 1 >= len(args) or args[i + 1] != repo:
                return False, "--repo does not match the brokered repository"

    verb = args[1] if len(args) > 1 else ""

    if verb == "view":
        # issue view <ref> --repo R --comments --json F
        if len(args) < 3 or _is_flag(args[2]) or not args[2].isdigit():
            return False, "issue view: missing or invalid issue number"
        for i, a in enumerate(args):
            if a == "--json":
                if i + 1 >= len(args) or not _check_json_fields(args[i + 1]):
                    return False, "issue view: unexpected --json fields"
        allowed = {"--repo", "--comments", "--json"}
        return _only_known_flags(args[3:], allowed, "issue view")

    if verb == "list":
        # issue list --repo R (--search Q | --state open --label A --label B)
        #            --limit 1000 --json number
        for i, a in enumerate(args):
            if a == "--json":
                if i + 1 >= len(args) or args[i + 1] != "number":
                    return False, "issue list: --json is limited to `number`"
            if a == "--limit":
                if i + 1 >= len(args) or not args[i + 1].isdigit() or int(args[i + 1]) > 1000:
                    return False, "issue list: --limit above 1000"
        allowed = {"--repo", "--search", "--state", "--label", "--limit", "--json"}
        return _only_known_flags(args[2:], allowed, "issue list")

    if verb == "edit":
        # issue edit <ref> --repo R (--add-label L | --remove-label L)
        if len(args) < 3 or not args[2].isdigit():
            return False, "issue edit: missing or invalid issue number"
        if not any(a in ("--add-label", "--remove-label") for a in args):
            return False, "issue edit: only label changes are brokered"
        allowed = {"--repo", "--add-label", "--remove-label"}
        return _only_known_flags(args[3:], allowed, "issue edit")

    if verb == "comment":
        # issue comment <ref> --repo R --body TEXT
        if len(args) < 3 or not args[2].isdigit():
            return False, "issue comment: missing or invalid issue number"
        if "--body" not in args:
            return False, "issue comment: --body is required"
        allowed = {"--repo", "--body"}
        return _only_known_flags(args[3:], allowed, "issue comment")

    return False, f"`gh issue {verb}` is not brokered"


def _only_known_flags(tail: list[str], allowed: set[str], label: str) -> tuple[bool, str]:
    i = 0
    while i < len(tail):
        token = tail[i]
        if not _is_flag(token):
            return False, f"{label}: unexpected positional argument"
        if token not in allowed:
            return False, f"{label}: flag {token} is not allowed"
        # Every allowed flag except --comments takes exactly one value.
        if token == "--comments":
            i += 1
            continue
        if i + 1 >= len(tail) or _is_flag(tail[i + 1]):
            return False, f"{label}: {token} expects a value"
        i += 2
    return True, "ok"


def impose_repo(args: list[str], repo: str) -> list[str]:
    """Drop any --repo the VM sent and re-add the brokered one."""
    out: list[str] = []
    i = 0
    while i < len(args):
        if args[i] == "--repo":
            i += 2
            continue
        out.append(args[i])
        i += 1
    return [*out, "--repo", repo]


def log(verdict: str, args: list[str], reason: str = "") -> None:
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    suffix = f" — {reason}" if reason else ""
    print(f"{stamp} {verdict}: gh {' '.join(args)}{suffix}", flush=True)


class Handler(BaseHTTPRequestHandler):
    repo = ""
    token = ""

    def _reply(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802 - name imposed by BaseHTTPRequestHandler
        authorization = self.headers.get("Authorization", "")
        if not self.token or not secrets.compare_digest(
            authorization.encode(), f"Bearer {self.token}".encode()
        ):
            log("REFUSED", [], "invalid run credential")
            self._reply(403, {"error": "invalid run credential"})
            return
        if self.path != "/gh":
            self._reply(404, {"error": "unknown endpoint"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            self._reply(413, {"error": "missing or oversized body"})
            return

        try:
            request = json.loads(self.rfile.read(length))
            args = request["args"]
            if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
                raise ValueError("args must be a list of strings")
        except Exception as error:  # noqa: BLE001 - any malformed input is one case
            self._reply(400, {"error": f"malformed request: {error}"})
            return

        allowed, reason = validate(args, self.repo)
        if not allowed:
            log("REFUSED", args, reason)
            self._reply(403, {"error": reason})
            return

        final = impose_repo(args, self.repo)
        log("ALLOWED", final)
        completed = subprocess.run(
            ["gh", *final], capture_output=True, text=True, timeout=120, check=False
        )
        self._reply(
            200,
            {
                "code": completed.returncode,
                "stdout": completed.stdout,
                "stderr": completed.stderr,
            },
        )

    def log_message(self, *_args) -> None:
        """Silence the default per-request logging; we log verdicts ourselves."""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True, help="the only repository the VM may touch")
    parser.add_argument("--host", default="10.174.226.1")
    parser.add_argument("--port", type=int, default=8099)
    parser.add_argument("--token-file", required=True, type=Path)
    opts = parser.parse_args()

    Handler.repo = opts.repo
    Handler.token = opts.token_file.read_text().strip()
    if len(Handler.token) != 64 or any(c not in "0123456789abcdef" for c in Handler.token):
        parser.error("token file must contain a 32-byte hexadecimal run credential")
    server = ThreadingHTTPServer((opts.host, opts.port), Handler)
    print(f"gh broker on http://{opts.host}:{opts.port}/gh for {opts.repo}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("stopped", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
