#!/usr/bin/env bash
# Runs the gh broker for the lifetime of one night run, and nothing more.
#
# The broker holds the forge credential, so it must not outlive the run: it is
# started here as a child process and killed by the EXIT trap, whatever ends the
# script -- normal exit, Ctrl-C, or a failing command.
#
#   ./night-run.sh --vm nuit-run-01 --repo owner/name -- <command...>
#   ./night-run.sh --vm nuit-run-01 --repo owner/name        # no command: hold
#                                                            # until Ctrl-C
#
# ONE BROKER PER RUN. `--repo` is imposed at broker startup, so two runs on two
# repositories need two brokers, hence two ports. The port is derived from the
# numeric suffix of the VM name (nuit-run-01 -> 8100) so that it is predictable
# from the run alone; `--port` overrides it. The resulting endpoint is written
# into the VM at /etc/lance-nuit/gh-broker.url, which the shim reads.
#
# JOURNAL. The broker's ALLOWED/REFUSED verdicts go to <run-dir>/gh-broker.log,
# under ~/.lance-nuit/night-runs/ by default, so the morning has one directory
# per run holding the broker's decisions next to whatever the run brings back.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
GATEWAY=10.174.226.1
BASE_PORT=8099
ENDPOINT_FILE=/etc/lance-nuit/gh-broker.url

VM=""
REPO=""
PORT=""
RUN_DIR=""

usage() {
	sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
	exit 2
}

while [ $# -gt 0 ]; do
	case "$1" in
	--vm) VM=${2:?--vm needs a value}; shift 2 ;;
	--repo) REPO=${2:?--repo needs a value}; shift 2 ;;
	--port) PORT=${2:?--port needs a value}; shift 2 ;;
	--run-dir) RUN_DIR=${2:?--run-dir needs a value}; shift 2 ;;
	--gateway) GATEWAY=${2:?--gateway needs a value}; shift 2 ;;
	--) shift; break ;;
	*) echo "unknown argument: $1" >&2; usage ;;
	esac
done

[ -n "$VM" ] || { echo "--vm is required" >&2; usage; }
[ -n "$REPO" ] || { echo "--repo is required" >&2; usage; }

# Port from the VM's numeric suffix: predictable, and distinct for distinct runs.
if [ -z "$PORT" ]; then
	suffix=${VM##*[!0-9]}
	PORT=$((BASE_PORT + 10#${suffix:-0}))
fi

if [ -z "$RUN_DIR" ]; then
	RUN_DIR="${PIPELINE_HOME:-$HOME/.lance-nuit}/night-runs/$VM-$(date +%Y%m%d-%H%M%S)"
fi
LOG="$RUN_DIR/gh-broker.log"

echo "== preflight =="

# 1. The broker is worthless without the host credential, and the failure would
#    only surface hours later as refused issue reads.
gh auth status >/dev/null 2>&1 || {
	echo "the host gh is not authenticated: the broker would have no credential" >&2
	exit 1
}
echo "host gh: authenticated"

# 2. The VM must already exist and answer; this script owns the broker, not the VM.
incus exec "$VM" -- true >/dev/null 2>&1 || {
	echo "VM '$VM' does not answer (not created, or not started)" >&2
	exit 1
}
echo "VM $VM: reachable"

# 3. A port already taken means another broker is running -- possibly on another
#    repository. Refuse rather than let two runs share one credential scope.
if (exec 3<>"/dev/tcp/$GATEWAY/$PORT") 2>/dev/null; then
	exec 3>&-
	echo "port $PORT is already in use on $GATEWAY: another broker is running" >&2
	exit 1
fi
echo "port $PORT: free"

mkdir -p "$RUN_DIR"

ENDPOINT="http://$GATEWAY:$PORT/gh"
echo "== endpoint =="
incus exec "$VM" -- mkdir -p "$(dirname "$ENDPOINT_FILE")"
echo "$ENDPOINT" | incus exec "$VM" -- tee "$ENDPOINT_FILE" >/dev/null
echo "$VM:$ENDPOINT_FILE -> $ENDPOINT"

BROKER_PID=""
TOKEN_FILE=""
cleanup() {
	local code=$?
	if [ -n "$BROKER_PID" ]; then
		kill "$BROKER_PID" 2>/dev/null || true
		wait "$BROKER_PID" 2>/dev/null || true
		BROKER_PID=""
	fi
	[ -z "$TOKEN_FILE" ] || rm -f -- "$TOKEN_FILE"
	echo
	echo "== broker stopped =="
	if [ -f "$LOG" ]; then
		printf "allowed: %s   refused: %s\n" \
			"$(grep -c ' ALLOWED: ' "$LOG" || true)" \
			"$(grep -c ' REFUSED: ' "$LOG" || true)"
		grep ' REFUSED: ' "$LOG" | tail -5 || true
		echo "journal: $LOG"
	fi
	return $code
}
trap cleanup EXIT

TOKEN_FILE=$(mktemp)
python3 -c 'import secrets; print(secrets.token_hex(32))' >"$TOKEN_FILE"
incus file push "$TOKEN_FILE" "$VM/etc/lance-nuit/gh-broker.token" --mode 0600

echo "== broker =="
python3 "$HERE/broker/gh-broker.py" --repo "$REPO" --host "$GATEWAY" --port "$PORT" --token-file "$TOKEN_FILE" >>"$LOG" 2>&1 &
BROKER_PID=$!

for _ in $(seq 1 30); do
	kill -0 "$BROKER_PID" 2>/dev/null || { echo "broker died on startup:" >&2; cat "$LOG" >&2; exit 1; }
	(exec 3<>"/dev/tcp/$GATEWAY/$PORT") 2>/dev/null && { exec 3>&-; break; }
	sleep 1
done
(exec 3<>"/dev/tcp/$GATEWAY/$PORT") 2>/dev/null || { echo "broker did not open $GATEWAY:$PORT" >&2; exit 1; }
exec 3>&-
echo "broker pid $BROKER_PID on $ENDPOINT for $REPO"
echo "journal: $LOG"

if [ $# -gt 0 ]; then
	echo
	echo "== run =="
	"$@"
else
	echo
	echo "No command given: holding the broker up. Ctrl-C to stop it."
	wait "$BROKER_PID"
fi
