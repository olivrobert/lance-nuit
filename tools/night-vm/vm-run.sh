#!/usr/bin/env bash
# Runs inside the night VM, as 'nuit', in the transient unit night.sh starts:
#
#   vm-run.sh <pipeline> [--replay-interrupted]
#
# The Claude token arrives as the unit's credential (LoadCredential, read by
# systemd from the read-only secrets mount): it lives in the environment of this
# process tree only, never in a file 'nuit' could leave behind.
set -euo pipefail

PIPELINE=${1:?usage: vm-run.sh <pipeline> [--replay-interrupted]}
REPLAY=${2:-}

CLAUDE_CODE_OAUTH_TOKEN=$(<"$CREDENTIALS_DIRECTORY/claude")
export CLAUDE_CODE_OAUTH_TOKEN
cd /srv/project

echo "== claude check ($(date -Iseconds)) =="
# The home of 'nuit' holds no Claude configuration: claude must answer from the
# token alone, without onboarding or a permission prompt. stdin is closed so a
# prompt fails here, in seconds, instead of stalling the night's first step.
timeout 180 claude -p "Reply with the single word OK." --model haiku \
	--permission-mode bypassPermissions --setting-sources project --strict-mcp-config </dev/null

if [ "$REPLAY" = "--replay-interrupted" ]; then
	# `--replay-interrupted` is refused under `--scan`: the ticket cut in flight
	# is the one the latest scan record left `running`, replayed alone first.
	ticket=$(node -e '
		const fs = require("fs");
		const dir = ".lance-nuit/pipeline-history/scans";
		const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
		const last = files.length ? JSON.parse(fs.readFileSync(`${dir}/${files.at(-1)}`, "utf8")) : {};
		const running = Object.entries(last.tickets ?? {}).find(([, t]) => t.state === "running");
		process.stdout.write(running ? running[0] : "");')
	if [ -n "$ticket" ]; then
		echo "== replay ticket $ticket ($(date -Iseconds)) =="
		lancenuit run "$ticket" --pipeline "$PIPELINE" --replay-interrupted ||
			echo "replay of $ticket failed; the scan below reports it"
	else
		echo "no ticket was cut in flight: nothing to replay"
	fi
fi

echo "== lancenuit scan ($(date -Iseconds)) =="
exec lancenuit run --pipeline "$PIPELINE" --scan
