#!/usr/bin/env bash
# One night of lance-nuit in a throwaway VM, from the host.
#
#   night.sh start --project <dir> --pipeline <name> [--base <branch>] [--repo owner/name]
#   night.sh resume <run-id> [--replay-interrupted]
#   night.sh status [<run-id>]
#   night.sh clean <run-id>
#
# `start` checks its inputs, then hands the night to a systemd user unit
# `nuit-<run-id>` held under `systemd-inhibit --what=sleep`, and returns. That
# unit clones the VM, wires the ACL and the Claude token, ships the base branch
# as a bundle, starts the gh broker, runs the project's .lance-nuit/vm-prepare.sh
# and then `lancenuit run --scan` in a transient unit of the VM, and brings the
# results back to ~/.lance-nuit/night-runs/<run-id>/ whatever happened.
#
# Each phase leaves a marker in <run-dir>/phases/; `resume` skips the phases
# already marked. The VM is deleted when the run passed with a verified bundle,
# stopped and kept otherwise, until `clean`.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
RUNS_DIR="${PIPELINE_HOME:-$HOME/.lance-nuit}/night-runs"
TOKEN_SOURCE=${NIGHT_TOKEN_FILE:-$HOME/.config/lance-nuit/claude-oauth-token}
GH_TOKEN_SOURCE=${NIGHT_GH_TOKEN_FILE:-$HOME/.config/lance-nuit/gh-broker-token}
SECRETS_ROOT=${NIGHT_SECRETS_ROOT:-/dev/shm}
GATEWAY=${NIGHT_GATEWAY:-10.174.226.1}
POLL_SECONDS=${NIGHT_POLL_SECONDS:-60}
TEMPLATE=nuit-template/clean
FIRST_PORT=8099
LAST_PORT=8199
PREPARE_TIMEOUT=15m
RUN_TIMEOUT=7h
PROJECT_DIR=/srv/project
SECRETS_MOUNT=/mnt/nuit-secrets
VM_UNIT=night-run

usage() {
	sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
	exit 2
}

die() {
	echo "night.sh: $*" >&2
	exit 1
}

say() { printf '\n== %s (%s) ==\n' "$1" "$(date +%H:%M:%S)"; }

run_dir_of() {
	[[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,50}$ ]] || die "invalid run id: $1"
	echo "$RUNS_DIR/$1"
}

load_run() {
	RUN_ID=$1
	RUN_DIR=$(run_dir_of "$RUN_ID")
	[ -f "$RUN_DIR/run.env" ] || die "no night run $RUN_ID under $RUNS_DIR"
	# shellcheck source=/dev/null
	source "$RUN_DIR/run.env"
	VM=nuit-$RUN_ID
	SECRETS_DIR=$SECRETS_ROOT/nuit-$RUN_ID
}

host_unit_active() {
	systemctl --user is-active --quiet "nuit-$1"
}

done_phase() { [ -f "$RUN_DIR/phases/$1" ]; }
mark_phase() { date -Iseconds >"$RUN_DIR/phases/$1"; }

check_secret_file() {
	local file=$1 hint=$2
	[ -f "$file" ] && [ ! -L "$file" ] || die "no $hint at $file"
	local mode owner
	read -r mode owner < <(stat -c '%a %u' "$file")
	[ "$owner" = "$(id -u)" ] || die "$file is not yours"
	case "$mode" in
	600 | 400) ;;
	*) die "$file has mode $mode: refusing a token others can read (chmod 600)" ;;
	esac
	[ -s "$file" ] || die "$file is empty"
}

check_token() {
	check_secret_file "$TOKEN_SOURCE" "Claude token (create it with 'claude setup-token', mode 0600)"
	check_secret_file "$GH_TOKEN_SOURCE" "GitHub token for the broker (fine-grained, Issues: read and write on the project only, mode 0600)"
}

launch() {
	local args=("$HERE/night.sh" _run "$RUN_ID" "$@")
	systemd-run --user --unit "nuit-$RUN_ID" --collect --quiet \
		--setenv=PATH="$PATH" \
		${PIPELINE_HOME:+--setenv=PIPELINE_HOME="$PIPELINE_HOME"} \
		${NIGHT_TOKEN_FILE:+--setenv=NIGHT_TOKEN_FILE="$NIGHT_TOKEN_FILE"} \
		${NIGHT_GH_TOKEN_FILE:+--setenv=NIGHT_GH_TOKEN_FILE="$NIGHT_GH_TOKEN_FILE"} \
		--property=TimeoutStopSec=300 \
		--property=StandardOutput="append:$RUN_DIR/night.log" \
		--property=StandardError="append:$RUN_DIR/night.log" \
		"$(command -v systemd-inhibit)" --what=sleep --mode=block --who=night.sh \
		--why="night run $RUN_ID" "${args[@]}"
	echo "night $RUN_ID started in unit nuit-$RUN_ID"
	echo "  follow:  tail -f $RUN_DIR/night.log"
	echo "  status:  $0 status $RUN_ID"
	if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
		echo "warning: lingering is off, so logging out stops the night (loginctl enable-linger)" >&2
	fi
}

cmd_start() {
	local project="" pipeline="" base="" repo=""
	while [ $# -gt 0 ]; do
		case "$1" in
		--project) project=${2:?--project needs a value}; shift 2 ;;
		--pipeline) pipeline=${2:?--pipeline needs a value}; shift 2 ;;
		--base) base=${2:?--base needs a value}; shift 2 ;;
		--repo) repo=${2:?--repo needs a value}; shift 2 ;;
		*) usage ;;
		esac
	done
	[ -n "$project" ] && [ -n "$pipeline" ] || usage
	project=$(cd "$project" && pwd)
	git -C "$project" rev-parse --git-dir >/dev/null 2>&1 || die "$project is not a git repository"
	local config=$project/.lance-nuit/config.json
	[ -n "$base" ] || base=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("baseBranch", "main"))' "$config" 2>/dev/null || echo main)
	[ -n "$repo" ] || repo=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["workItem"]["project"])' "$config" 2>/dev/null) ||
		die "no --repo and no workItem.project in $config"

	# The VM sees the base branch only: what it needs must be committed there.
	git -C "$project" rev-parse --verify --quiet "refs/heads/$base" >/dev/null || die "no branch $base in $project"
	local file
	for file in ".lance-nuit/pipelines/$pipeline.ts" .lance-nuit/vm-prepare.sh; do
		git -C "$project" cat-file -e "$base:$file" 2>/dev/null || die "$file is not committed on $base"
	done
	# The publisher bases its PRs on the branch as GitHub has it.
	local local_sha remote_sha
	local_sha=$(git -C "$project" rev-parse "refs/heads/$base")
	remote_sha=$(git -C "$project" ls-remote origin "refs/heads/$base" | cut -f1)
	[ "$local_sha" = "$remote_sha" ] || die "$base is not pushed as is (local ${local_sha:0:7}, origin ${remote_sha:0:7}): the morning's PRs could not be based on it"

	check_token
	gh auth status >/dev/null 2>&1 || die "the host gh is not authenticated: the broker would have no credential"

	local slug
	slug=$(basename "$project" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-' | cut -c1-20)
	RUN_ID=${slug%-}-$(date +%Y%m%d-%H%M%S)
	RUN_DIR=$(run_dir_of "$RUN_ID")
	mkdir -p "$RUN_DIR/phases"
	{
		printf 'PROJECT=%q\n' "$project"
		printf 'PIPELINE=%q\n' "$pipeline"
		printf 'BASE=%q\n' "$base"
		printf 'REPO=%q\n' "$repo"
	} >"$RUN_DIR/run.env"
	launch
}

cmd_resume() {
	local id=${1:-}
	[ -n "$id" ] || usage
	shift
	local replay=()
	case "${1:-}" in
	"") ;;
	--replay-interrupted) replay=(--replay-interrupted) ;;
	*) usage ;;
	esac
	load_run "$id"
	host_unit_active "$RUN_ID" && die "night $RUN_ID is still running"
	[ ! -f "$RUN_DIR/phases/cleaned" ] || die "night $RUN_ID was cleaned: its VM is gone"
	check_token
	rm -f "$RUN_DIR/result.json"
	echo "--- resume $(date -Iseconds) ---" >>"$RUN_DIR/night.log"
	launch "${replay[@]}"
}

cmd_status() {
	[ $# -le 1 ] || usage
	python3 "$HERE/night_report.py" status "$RUNS_DIR" "$@"
}

cmd_clean() {
	[ $# -eq 1 ] || usage
	load_run "$1"
	host_unit_active "$RUN_ID" && die "night $RUN_ID is still running: systemctl --user stop nuit-$RUN_ID first"
	if incus info "$VM" >/dev/null 2>&1; then
		incus delete "$VM" --force
		echo "deleted $VM"
	fi
	rm -rf -- "$SECRETS_DIR"
	mark_phase cleaned
	echo "run dir kept: $RUN_DIR"
}

# ---------------------------------------------------------------------------
# Inside the unit.

BROKER_PID=""
BROKER_TOKEN=""
CURRENT_PHASE=""
FAILED_PHASE=""
VM_RESULT=""
EXIT_STATUS=""
INTERRUPTED=0

in_vm_as_nuit() {
	incus exec "$VM" --user 1001 --group 1001 --env HOME=/home/nuit --cwd "$PROJECT_DIR" -- "$@"
}

vm_answers() {
	incus exec "$VM" -- true >/dev/null 2>&1
}

wait_for_vm() {
	local _
	for _ in $(seq 1 120); do vm_answers && break; sleep 1; done
	for _ in $(seq 1 60); do incus exec "$VM" -- docker info >/dev/null 2>&1 && return 0; sleep 1; done
	return 1
}

phase_vm() {
	if incus info "$VM" >/dev/null 2>&1; then
		echo "$VM exists: a half-made VM is not trusted, recreating it"
		incus delete "$VM" --force
	fi
	incus copy "$TEMPLATE" "$VM"
	"$HERE/network-acl.sh" apply "$VM"
}

# Before every boot: /dev/shm does not survive a host reboot, so a resume
# copies the token again. The VM reads it through a read-only share; the host
# copy goes when the run ends.
phase_secrets() {
	install -d -m 0700 "$SECRETS_DIR"
	install -m 0600 "$TOKEN_SOURCE" "$SECRETS_DIR/claude-oauth-token"
	if ! incus config device get "$VM" secrets source >/dev/null 2>&1; then
		incus config device add "$VM" secrets disk source="$SECRETS_DIR" path="$SECRETS_MOUNT" readonly=true
	fi
}

phase_boot() {
	vm_answers || incus start "$VM"
	wait_for_vm || { echo "$VM did not come up with Docker" >&2; return 1; }
}

phase_code() {
	git -C "$PROJECT" bundle create "$RUN_DIR/in.bundle" "refs/heads/$BASE"
	incus file push "$RUN_DIR/in.bundle" "$VM/tmp/in.bundle" --mode 0644
	rm -f -- "$RUN_DIR/in.bundle"
	incus exec "$VM" -- bash -c "rm -rf $PROJECT_DIR && install -d -o nuit -g nuit $PROJECT_DIR"
	# `bundle verify` needs a repository to check prerequisites against, and
	# must come before the clone to be a gate. No remote is left behind.
	incus exec "$VM" --user 1001 --group 1001 --env HOME=/home/nuit -- bash -c '
		set -e
		rm -rf /tmp/verify && git init -q /tmp/verify
		git -C /tmp/verify bundle verify /tmp/in.bundle
		rm -rf /tmp/verify
		git clone -q -b "$1" /tmp/in.bundle "$2"
		git -C "$2" remote remove origin
		git -C "$2" config user.name lance-nuit
		git -C "$2" config user.email nuit@lance-nuit.invalid' _ "$BASE" "$PROJECT_DIR"
	incus exec "$VM" -- rm -f /tmp/in.bundle
}

port_free() {
	python3 -c 'import socket, sys; socket.socket().bind((sys.argv[1], int(sys.argv[2])))' "$GATEWAY" "$1" 2>/dev/null
}

# The broker lives exactly as long as this unit: started here, killed in finish.
phase_broker() {
	local port
	for port in $(seq "$FIRST_PORT" "$LAST_PORT"); do port_free "$port" && break; port=""; done
	[ -n "$port" ] || { echo "no free broker port in $FIRST_PORT-$LAST_PORT" >&2; return 1; }
	echo "$port" >"$RUN_DIR/broker.port"

	BROKER_TOKEN=$(mktemp "${XDG_RUNTIME_DIR:-/tmp}/night-broker.XXXXXX")
	python3 -c 'import secrets; print(secrets.token_hex(32))' >"$BROKER_TOKEN"
	incus exec "$VM" -- mkdir -p /etc/lance-nuit
	echo "http://$GATEWAY:$port/gh" | incus exec "$VM" -- tee /etc/lance-nuit/gh-broker.url >/dev/null
	incus file push "$BROKER_TOKEN" "$VM/etc/lance-nuit/gh-broker.token" --mode 0600 --uid 1001 --gid 1001

	# The broker answers with the night's fine-grained token, never the host's own gh login.
	GH_TOKEN=$(<"$GH_TOKEN_SOURCE") python3 "$HERE/broker/gh-broker.py" --repo "$REPO" --host "$GATEWAY" --port "$port" \
		--token-file "$BROKER_TOKEN" >>"$RUN_DIR/gh-broker.log" 2>&1 &
	BROKER_PID=$!
	local _
	for _ in $(seq 1 30); do
		kill -0 "$BROKER_PID" 2>/dev/null || { echo "broker died on startup" >&2; return 1; }
		port_free "$port" || { echo "broker on $GATEWAY:$port for $REPO"; return 0; }
		sleep 1
	done
	echo "broker did not open $GATEWAY:$port" >&2
	return 1
}

stop_broker() {
	if [ -n "$BROKER_PID" ]; then
		kill "$BROKER_PID" 2>/dev/null || true
		wait "$BROKER_PID" 2>/dev/null || true
		BROKER_PID=""
	fi
	[ -z "$BROKER_TOKEN" ] || rm -f -- "$BROKER_TOKEN"
	if [ -f "$RUN_DIR/gh-broker.log" ]; then
		printf 'broker: %s allowed, %s refused\n' \
			"$(grep -c ' ALLOWED: ' "$RUN_DIR/gh-broker.log" || true)" \
			"$(grep -c ' REFUSED: ' "$RUN_DIR/gh-broker.log" || true)"
	fi
}

# Rerun on every start: a stopped VM has lost its containers, and the script is
# idempotent. A failure stops the night before any token is spent.
phase_prepare() {
	incus exec "$VM" -- su - nuit -c "cd $PROJECT_DIR && timeout $PREPARE_TIMEOUT .lance-nuit/vm-prepare.sh" 2>&1 |
		tee -a "$RUN_DIR/prepare.log"
}

vm_unit_state() {
	incus exec "$VM" -- systemctl show "$VM_UNIT" -p SubState -p Result -p ExecMainStatus
}

phase_run() {
	local replay=("$@")
	incus file push "$HERE/vm-run.sh" "$VM/usr/local/bin/night-vm-run" --mode 0755 --uid 0 --gid 0
	incus exec "$VM" -- bash -c "systemctl stop $VM_UNIT 2>/dev/null; systemctl reset-failed $VM_UNIT 2>/dev/null; true"
	incus exec "$VM" -- systemd-run --unit "$VM_UNIT" --uid nuit --gid nuit \
		--property=RemainAfterExit=yes \
		--property=RuntimeMaxSec="$RUN_TIMEOUT" \
		--property=LoadCredential="claude:$SECRETS_MOUNT/claude-oauth-token" \
		--property=WorkingDirectory="$PROJECT_DIR" \
		--property=StandardOutput=append:/home/nuit/night-run.log \
		--property=StandardError=append:/home/nuit/night-run.log \
		/bin/bash -l /usr/local/bin/night-vm-run "$PIPELINE" "${replay[@]}"
	echo "VM unit $VM_UNIT started, polled every ${POLL_SECONDS}s"

	local state sub misses=0
	while :; do
		sleep "$POLL_SECONDS" &
		wait $! || true
		if ! state=$(vm_unit_state 2>/dev/null); then
			misses=$((misses + 1))
			[ "$misses" -lt 5 ] || { echo "the VM stopped answering" >&2; VM_RESULT=unreachable; return 1; }
			continue
		fi
		misses=0
		sub=$(sed -n 's/^SubState=//p' <<<"$state")
		case "$sub" in
		running | start | start-pre | start-post | reload) continue ;;
		esac
		VM_RESULT=$(sed -n 's/^Result=//p' <<<"$state")
		EXIT_STATUS=$(sed -n 's/^ExecMainStatus=//p' <<<"$state")
		echo "VM unit ended: result $VM_RESULT, exit $EXIT_STATUS"
		[ "$VM_RESULT" = success ] && [ "$EXIT_STATUS" = 0 ]
		return
	done
}

# Always, whatever ended the run. What comes back is untrusted: the archive is
# unpacked with Python's "data" filter, and nothing of it is executed.
fetch_results() {
	say "fetch"
	in_vm_as_nuit bash -c '
		set -u
		out=/tmp/night-out
		rm -rf "$out" && mkdir -p "$out"
		if git for-each-ref --format="%(refname)" "refs/heads/nuit/" | grep -q .; then
			git bundle create "$out/out.bundle" --branches="nuit/*" "^$1" || echo "no commit above $1 on nuit/*"
		fi
		git status --short --branch >"$out/worktree.status"
		export GIT_INDEX_FILE="$out/index"
		git read-tree HEAD && git add -A && git diff --cached --binary HEAD >"$out/worktree.patch"
		rm -f "$out/index"
		dirs=$(cd .lance-nuit && ls -d work-items pipeline-history 2>/dev/null)
		[ -z "$dirs" ] || tar czf "$out/lance-nuit.tgz" -C .lance-nuit $dirs
		cp /home/nuit/night-run.log "$out/run.log" 2>/dev/null
		true' _ "$BASE" || echo "fetch inside the VM failed" >&2

	local file
	for file in out.bundle worktree.status worktree.patch lance-nuit.tgz run.log; do
		rm -f -- "${RUN_DIR:?}/$file"
		incus file pull "$VM/tmp/night-out/$file" "$RUN_DIR/$file" 2>/dev/null || true
	done
	[ -s "$RUN_DIR/worktree.patch" ] || rm -f -- "$RUN_DIR/worktree.patch"
	if [ -f "$RUN_DIR/lance-nuit.tgz" ]; then
		rm -rf -- "${RUN_DIR:?}/work-items" "${RUN_DIR:?}/pipeline-history"
		python3 -c 'import sys, tarfile; tarfile.open(sys.argv[1]).extractall(sys.argv[2], filter="data")' \
			"$RUN_DIR/lance-nuit.tgz" "$RUN_DIR" || echo "could not unpack lance-nuit.tgz" >&2
	fi
	rm -f -- "$RUN_DIR/phases/bundle-verified"
	if [ -f "$RUN_DIR/out.bundle" ]; then
		if git -C "$PROJECT" bundle verify "$RUN_DIR/out.bundle" >/dev/null 2>&1; then
			mark_phase bundle-verified
			git bundle list-heads "$RUN_DIR/out.bundle"
		else
			echo "out.bundle does not verify against $PROJECT" >&2
		fi
	fi
}

finish() {
	local code=$?
	set +e
	trap - EXIT
	# systemd signals the whole unit again when systemd-inhibit exits: the
	# fetch must survive that second SIGTERM.
	trap '' TERM INT
	# A run whose VM unit ended is judged on its exit status, not as a phase.
	if [ "$code" != 0 ] && [ "$INTERRUPTED" = 0 ] && { [ "$CURRENT_PHASE" != run ] || [ -z "$VM_RESULT" ] || [ "$VM_RESULT" = unreachable ]; }; then
		FAILED_PHASE=${CURRENT_PHASE:-night.sh}
	fi
	stop_broker
	vm_answers && fetch_results

	local state
	state=$(python3 "$HERE/night_report.py" classify "$RUN_DIR" "$FAILED_PHASE" "$VM_RESULT" "${EXIT_STATUS:-none}" "$INTERRUPTED")
	say "night $state"
	cat "$RUN_DIR/result.json"

	if incus info "$VM" >/dev/null 2>&1; then
		if [ "$state" = passed ]; then
			incus delete "$VM" --force && echo "deleted $VM"
		else
			incus stop "$VM" --timeout 60 2>/dev/null || incus stop "$VM" --force 2>/dev/null
			incus config device remove "$VM" secrets >/dev/null 2>&1
			echo "kept $VM, stopped: night.sh clean $RUN_ID removes it"
		fi
	fi
	rm -rf -- "$SECRETS_DIR"
	echo "token removed from $SECRETS_DIR"
	exit "$code"
}

# Called as a plain command, never in a condition: `set -e` must stay in force
# inside the phase, and a failing phase ends the unit through finish.
run_phase() {
	CURRENT_PHASE=$1
	shift
	say "$CURRENT_PHASE"
	"phase_$CURRENT_PHASE" "$@"
	mark_phase "$CURRENT_PHASE"
}

cmd_run() {
	load_run "$1"
	shift
	trap finish EXIT
	trap 'INTERRUPTED=1; exit 143' TERM INT
	say "night $RUN_ID: $PIPELINE on $(basename "$PROJECT")@$BASE"
	check_token
	if ! done_phase vm; then run_phase vm; fi
	run_phase secrets
	run_phase boot
	if ! done_phase code; then run_phase code; fi
	run_phase broker
	run_phase prepare
	run_phase run "$@"
}

case "${1:-}" in
start) shift; cmd_start "$@" ;;
resume) shift; cmd_resume "$@" ;;
status) shift; cmd_status "$@" ;;
clean) shift; cmd_clean "$@" ;;
_run) shift; cmd_run "$@" ;;
*) usage ;;
esac
