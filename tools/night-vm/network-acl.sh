#!/usr/bin/env bash
# Create the 'nuit' network ACL and apply it to one instance.
# Point 3 of the 2026-09-20 hardening.
#
#   ./network-acl.sh create          create/refresh the ACL
#   ./network-acl.sh apply <vm>      attach it to that instance's NIC
#   ./network-acl.sh test <vm>       check what the VM can still reach
#
# WHAT THIS DOES AND DOES NOT DO
# Incus ACLs filter on address, protocol and port -- not on domain names. The
# agent APIs sit behind CDNs with rotating addresses, so an address allowlist is
# not maintainable. This ACL therefore keeps 80/443 open to the world and closes
# everything else, which already removes outbound SSH (so `git@github.com:` is
# dead) and every non-web protocol. Restricting *which* HTTPS hosts are
# reachable needs a filtering proxy on the host; see the ticket.
#
# WHY A DEDICATED BRIDGE
# On a bridge network -- unlike OVN -- `security.acls` is an option of the
# NETWORK, not of the NIC: an ACL placed on incusbr0 would apply to every
# instance on it, the template included, while it was being provisioned. So the
# ACL lives on its own bridge, and `apply` moves a run VM onto it. IPv6 is off
# there on purpose: a dual-stacked VM reaches AAAA-only routes without the IPv4
# path being up, which hides exactly the kind of break this setup must surface.
set -euo pipefail

ACL=nuit
BRIDGE=nuitbr0
GATEWAY=10.174.226.1
SUBNET=10.174.226.1/24
BROKER_PORTS=8099-8199

create() {
	incus network acl show "$ACL" >/dev/null 2>&1 || incus network acl create "$ACL"

	# Rebuild the rule set from scratch so the script stays idempotent.
	incus network acl rule remove "$ACL" egress --force 2>/dev/null || true

	# DNS to the Incus resolver only.
	incus network acl rule add "$ACL" egress action=allow protocol=udp \
		destination="$GATEWAY" destination_port=53
	incus network acl rule add "$ACL" egress action=allow protocol=tcp \
		destination="$GATEWAY" destination_port=53

	# The gh broker, on the host, one port per run (see night-run.sh: 8099 plus
	# the VM's numeric suffix). Without this rule the shim cannot reach the
	# broker once the ACL is applied, and every `gh` call exits 127.
	incus network acl rule add "$ACL" egress action=allow protocol=tcp \
		destination="$GATEWAY" destination_port="$BROKER_PORTS"

	# Web egress: agent APIs, Docker registry, npm, apt.
	incus network acl rule add "$ACL" egress action=allow protocol=tcp \
		destination_port=443
	incus network acl rule add "$ACL" egress action=allow protocol=tcp \
		destination_port=80

	incus network acl show "$ACL"

	# The bridge that carries the ACL. Everything not allowed above is refused,
	# SSH included: the default action is not an ACL option, it belongs to the
	# network the ACL is attached to.
	incus network show "$BRIDGE" >/dev/null 2>&1 || incus network create "$BRIDGE" \
		ipv4.address="$SUBNET" ipv4.nat=true ipv6.address=none
	incus network set "$BRIDGE" security.acls="$ACL"
	incus network set "$BRIDGE" security.acls.default.egress.action=reject
	incus network set "$BRIDGE" security.acls.default.ingress.action=reject
	incus network show "$BRIDGE"

	echo
	echo "Docker's FORWARD DROP also applies to $BRIDGE: incus-docker-forward.service"
	echo "must cover it. Reinstall it if it predates this bridge:"
	echo "  sudo cp incus-docker-forward.service /etc/systemd/system/ &&"
	echo "  sudo systemctl daemon-reload && sudo systemctl restart incus-docker-forward"
}

# Prints "<device> <network>" for the first nic of an instance's configuration.
# Reads the expanded view so that a nic inherited from a profile is found too.
nic_of() {
	incus config show --expanded "$1" | awk '
		/^devices:/ { in_devices = 1; next }
		in_devices && /^[a-z]/ { exit }
		in_devices && /^  [A-Za-z0-9_.-]+:$/ { name = substr($1, 1, length($1) - 1); network = "" }
		in_devices && /^    network:/ { network = $2 }
		in_devices && /^    type: nic$/ { print name, network; exit }
	'
}

apply() {
	local vm=$1
	local name network

	read -r name network <<<"$(nic_of "$vm")"
	if [ -z "$name" ]; then
		echo "no nic found on $vm" >&2
		return 1
	fi
	incus network show "$BRIDGE" >/dev/null 2>&1 || {
		echo "$BRIDGE does not exist: run '$0 create' first" >&2
		return 1
	}

	# A nic inherited from a profile cannot be edited in place; it is overridden
	# at instance level under the same name, pointing at the hardened bridge.
	if incus config device get "$vm" "$name" type >/dev/null 2>&1; then
		incus config device set "$vm" "$name" network="$BRIDGE"
	else
		incus config device add "$vm" "$name" nic network="$BRIDGE"
	fi
	incus config device show "$vm"

	echo "$vm is on $BRIDGE (was on ${network:-a profile network}); its address changes."
}

test_vm() {
	local vm=$1
	echo "-- allowed: HTTPS --"
	incus exec "$vm" -- curl -4 -sS -o /dev/null -w "github.com https -> %{http_code}\n" --max-time 10 https://github.com || true
	echo "-- allowed: DNS --"
	incus exec "$vm" -- getent ahostsv4 deb.debian.org | head -1
	echo "-- refused: outbound SSH (this is the point) --"
	incus exec "$vm" -- timeout 8 ssh -o StrictHostKeyChecking=no -o ConnectTimeout=6 git@github.com 2>&1 | tail -2 || echo "ssh blocked (expected)"
	echo "-- allowed: the broker port range on the gateway --"
	incus exec "$vm" -- timeout 8 bash -c "exec 3<>/dev/tcp/$GATEWAY/8199" 2>&1 \
		&& echo "gateway:8199 reachable" \
		|| echo "gateway:8199 refused connection (expected when no broker listens; a TIMEOUT here means the ACL blocks it)"
	echo "-- refused: arbitrary port --"
	incus exec "$vm" -- timeout 8 curl -4 -sS -o /dev/null --max-time 6 http://deb.debian.org:8888 2>&1 | tail -1 || echo "port 8888 blocked (expected)"
}

case "${1:-}" in
create) create ;;
apply) apply "${2:?usage: apply <vm>}" ;;
test) test_vm "${2:?usage: test <vm>}" ;;
*)
	echo "usage: $0 {create|apply <vm>|test <vm>}" >&2
	exit 2
	;;
esac
