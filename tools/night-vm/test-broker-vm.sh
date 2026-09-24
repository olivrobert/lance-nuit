#!/usr/bin/env bash
# End-to-end test of the gh shim FROM INSIDE a VM.
#
# Self-contained: clones the template into a throwaway VM, pushes the shim, starts
# the broker on the bridge gateway, runs the checks from the VM, tears everything
# down. Does not require harden.sh to have run, and leaves the template untouched.
#
# Read-only by default: nothing is written to the repository.
#   ./test-broker-vm.sh [--repo owner/name] [--acl] [--keep]
#
# --acl also applies the 'nuit' network ACL to the throwaway VM before testing.
# That is the only way to prove the ACL lets the VM reach the broker: without
# the dedicated egress rule every brokered call exits 127 instead of working.
set -uo pipefail

REPO=olivrobert/hypnose-rdv
VM=""
VM_CREATED=0
GATEWAY=10.174.226.1
# Deliberately NOT the shim's built-in default: reaching the broker on this port
# proves the VM resolved its endpoint from /etc/lance-nuit/gh-broker.url, the
# file night-run.sh writes for a per-run port.
PORT=8199
ENDPOINT_FILE=/etc/lance-nuit/gh-broker.url
KEEP=0
ACL=0
HERE=$(cd "$(dirname "$0")" && pwd)
RUN_DIR=$(mktemp -d)
# Incus instance names accept only alphanumerics and hyphens, and mktemp
# hands back a 'tmp.XXXXXXXX' suffix: strip everything else out.
VM="nuit-brokertest-$(printf %s "${RUN_DIR##*/}" | tr -cd '[:alnum:]')"

while [ $# -gt 0 ]; do
	case "$1" in
	--repo) REPO=$2; shift 2 ;;
	--keep) KEEP=1; shift ;;
	--acl) ACL=1; shift ;;
	*) echo "usage: $0 [--repo owner/name] [--acl] [--keep]" >&2; exit 2 ;;
	esac
done

BROKER_PID=""
cleanup() {
	[ -n "$BROKER_PID" ] && kill "$BROKER_PID" 2>/dev/null
	rm -rf "$RUN_DIR"
	if [ "$VM_CREATED" = 0 ]; then
		return
	elif [ "$KEEP" = 0 ]; then
		incus delete "$VM" --force 2>/dev/null
	else
		echo "VM $VM kept (--keep). Destroy it with: incus delete $VM --force"
	fi
}
trap cleanup EXIT

pass=0
fail=0
check() { # check <label> <expected: ok|refused> <output> <exit code>
	local label=$1 expect=$2 out=$3 code=$4
	local verdict
	if [ "$expect" = ok ]; then
		[ "$code" = 0 ] && verdict=PASS || verdict=FAIL
	else
		{ [ "$code" != 0 ] && echo "$out" | grep -qi "refused by broker"; } && verdict=PASS || verdict=FAIL
	fi
	[ "$verdict" = PASS ] && pass=$((pass + 1)) || fail=$((fail + 1))
	printf "%-4s %-46s %s\n" "$verdict" "$label" "$(echo "$out" | head -1 | cut -c1-60)"
}

echo "== 0. the host gh must be authenticated =="
if ! gh auth status >/dev/null 2>&1; then
	echo "FAIL: the host gh is not logged in — the broker would have no credential." >&2
	exit 1
fi
echo "host gh: authenticated"

echo
echo "== 1. throwaway VM from the template =="
incus copy nuit-template/clean "$VM" || exit 1
VM_CREATED=1

# Before the first boot: moving the nic to the hardened bridge changes the VM's
# address, so it has to be done while nothing has leased one yet.
if [ "$ACL" = 1 ]; then
	echo "== 1b. move the VM onto the hardened bridge =="
	"$HERE/network-acl.sh" apply "$VM" >/dev/null || exit 1
	echo "$VM is on the ACL'd bridge"
fi

incus start "$VM" || exit 1
for _ in $(seq 1 90); do incus exec "$VM" -- true 2>/dev/null && break; sleep 1; done

# Answering `true` only means the agent is up: DHCP and systemd-resolved come
# later. Without this wait the egress checks below race the network and fail on
# name resolution, which reads exactly like an ACL that blocks DNS.
for _ in $(seq 1 60); do
	incus exec "$VM" -- getent ahostsv4 deb.debian.org >/dev/null 2>&1 && break
	sleep 1
done

if [ "$ACL" = 1 ]; then
	echo "== 1c. what the ACL lets through =="
	# The point of the bridge is not that the broker works -- it is that nothing
	# else does. IPv4 explicitly: an AAAA-only route would answer even with the
	# IPv4 path down and prove nothing.
	out=$(incus exec "$VM" -- curl -4 -sS -o /dev/null -w "%{http_code}" --max-time 15 https://github.com 2>&1)
	if [ "$out" = 200 ]; then
		echo "PASS HTTPS egress works (github.com -> 200)"
		pass=$((pass + 1))
	else
		echo "FAIL HTTPS egress broken: $out (Docker FORWARD DROP on $VM's bridge?)"
		fail=$((fail + 1))
	fi

	# Blocked shows up either as a reject (connection refused) or as silence the
	# timeout cuts off; what must never appear is GitHub answering.
	out=$(incus exec "$VM" -- python3 -c '
import errno, socket, sys
try:
    addresses = socket.getaddrinfo("github.com", 22, socket.AF_INET, socket.SOCK_STREAM)
except OSError as error:
    print(error); sys.exit(2)
for family, kind, protocol, _, address in addresses:
    with socket.socket(family, kind, protocol) as connection:
        connection.settimeout(6)
        try:
            connection.connect(address)
        except OSError as error:
            if isinstance(error, TimeoutError) or error.errno in (errno.ECONNREFUSED, errno.EHOSTUNREACH, errno.ENETUNREACH, errno.EACCES):
                continue
            print(error); sys.exit(2)
        print("TCP port 22 reachable"); sys.exit(0)
sys.exit(1)
' 2>&1); code=$?
	if [ "$code" = 0 ]; then
		echo "FAIL outbound SSH reached github.com: $(echo "$out" | tail -1)"
		fail=$((fail + 1))
	elif [ "$code" = 1 ]; then
		echo "PASS outbound SSH blocked (${out:-no answer before the timeout})"
		pass=$((pass + 1))
	else
		echo "FAIL could not check outbound SSH: $out"
		fail=$((fail + 1))
	fi
fi

echo "== 2. push the shim as /usr/local/bin/gh =="
# Deliberately shadowing any real gh still present: /usr/local/bin comes first
# on PATH. That also proves the shim wins once harden.sh removes the real one.
incus file push "$HERE/broker/gh-shim" "$VM/usr/local/bin/gh" --mode 0755 || exit 1
incus exec "$VM" -- bash -lc 'command -v gh; head -2 "$(command -v gh)" | tail -1'

echo "== 2b. point the shim at this run's port =="
incus exec "$VM" -- mkdir -p "$(dirname "$ENDPOINT_FILE")"
echo "http://$GATEWAY:$PORT/gh" | incus exec "$VM" -- tee "$ENDPOINT_FILE"
TOKEN_FILE="$RUN_DIR/broker.token"
(umask 077; python3 -c 'import secrets; print(secrets.token_hex(32))' >"$TOKEN_FILE") || exit 1
incus file push "$TOKEN_FILE" "$VM/etc/lance-nuit/gh-broker.token" --mode 0600 || exit 1

echo
echo "== 3. broker on the gateway, host side =="
python3 "$HERE/broker/gh-broker.py" --repo "$REPO" --host "$GATEWAY" --port "$PORT" --token-file "$TOKEN_FILE" &
BROKER_PID=$!
sleep 2
kill -0 "$BROKER_PID" 2>/dev/null || { echo "FAIL: broker did not start" >&2; exit 1; }

run_in_vm() { incus exec "$VM" -- bash -lc "$1" 2>&1; }

echo
echo "== 4. what the VM may do =="
out=$(run_in_vm "gh issue list --repo $REPO --state open --limit 1000 --json number"); code=$?
check "issue list (real GitHub read)" ok "$out" $code
out=$(run_in_vm "gh issue list --repo $REPO --state open --limit 1000 --json number | head -c 40"); code=$?
echo "     → $out"

first=$(run_in_vm "gh issue list --repo $REPO --state open --limit 1000 --json number" | grep -oE '[0-9]+' | head -1)
if [ -n "$first" ]; then
	out=$(run_in_vm "gh issue view $first --repo $REPO --comments --json title,body,state,labels,comments,number"); code=$?
	check "issue view #$first" ok "$out" $code
else
	echo "SKIP issue view — no open issue to read"
fi

echo
echo "== 5. what the VM may NOT do =="
out=$(run_in_vm "gh auth token"); check "gh auth token" refused "$out" $?
out=$(run_in_vm "gh api /user"); check "gh api /user" refused "$out" $?
out=$(run_in_vm "gh repo clone $REPO /tmp/x"); check "gh repo clone" refused "$out" $?
out=$(run_in_vm "gh issue view 1 --repo attaquant/exfil --json title"); check "another repository" refused "$out" $?
out=$(run_in_vm "gh issue delete 1 --repo $REPO"); check "gh issue delete" refused "$out" $?
out=$(run_in_vm "gh issue edit 1 --repo $REPO --body pwn"); check "edit --body (not a label)" refused "$out" $?

echo
echo "== 6. no credential inside the VM =="
out=$(run_in_vm 'ls /root/.config/gh 2>&1'); echo "     /root/.config/gh: $out"
out=$(run_in_vm 'grep -rl "github_pat\|gh[pousr]_" /root /srv /etc 2>/dev/null | head -3')
[ -z "$out" ] && { echo "PASS no token-looking string under /root /srv /etc"; pass=$((pass+1)); } \
              || { echo "FAIL token-looking string found: $out"; fail=$((fail+1)); }

echo
echo "== 7. broker down = shim degrades cleanly =="
kill "$BROKER_PID" 2>/dev/null; BROKER_PID=""; sleep 1
out=$(run_in_vm "gh issue list --repo $REPO --json number"); code=$?
if [ "$code" = 127 ] && echo "$out" | grep -qi "broker unreachable"; then
	echo "PASS exit 127 + explicit message (lance-nuit reads 127 as 'binary missing')"
	pass=$((pass + 1))
else
	echo "FAIL expected exit 127 'broker unreachable', got $code: $(echo "$out" | head -1)"
	fail=$((fail + 1))
fi

echo
echo "== 8. night-run.sh frames the broker =="
# Same VM, but this time nothing starts or stops the broker by hand: night-run.sh
# does, and must take it down with itself. Its port comes from the VM name, and
# it rewrites the endpoint file, so this also re-tests that resolution path.
out=$("$HERE/night-run.sh" --vm "$VM" --repo "$REPO" --port "$PORT" --run-dir "$RUN_DIR" -- \
	incus exec "$VM" -- gh issue list --repo "$REPO" --state open --limit 1000 --json number 2>&1)
code=$?
if [ "$code" = 0 ] && echo "$out" | grep -q '"number"'; then
	echo "PASS the run read issues under night-run.sh"
	pass=$((pass + 1))
else
	echo "FAIL night-run.sh run failed ($code): $(echo "$out" | tail -3)"
	fail=$((fail + 1))
fi

if grep -q " ALLOWED: " "$RUN_DIR/gh-broker.log" 2>/dev/null; then
	echo "PASS verdicts journalled in <run-dir>/gh-broker.log"
	pass=$((pass + 1))
else
	echo "FAIL no ALLOWED verdict in $RUN_DIR/gh-broker.log"
	fail=$((fail + 1))
fi

# The broker carries the credential: outliving the run is the failure that matters.
out=$(incus exec "$VM" -- bash -lc "gh issue list --repo $REPO --json number" 2>&1); code=$?
if [ "$code" = 127 ]; then
	echo "PASS broker died with the run (shim back to 127)"
	pass=$((pass + 1))
else
	echo "FAIL broker still answering after night-run.sh returned ($code)"
	fail=$((fail + 1))
fi

echo
echo "================ $pass passed, $fail failed ================"
[ "$fail" = 0 ]
