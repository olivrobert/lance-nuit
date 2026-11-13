#!/usr/bin/env bash
# Provision nuit-template: clean lance-nuit install, current Claude Code CLI,
# the unprivileged 'nuit' user, pre-pulled and pre-built Docker images.
# Run from the host, no sudo needed.
set -euo pipefail

VM=nuit-template
# UID/GID of the agent user. Compose files commonly default to ${UID:-1001}, so
# files written by the project's containers stay owned by the agent.
NUIT_ID=1001
# Where run VMs clone the project: building there gives the image the tag a
# night's `docker compose up` looks for, not only its layer cache.
PROJECT_DIR=/srv/project
TGZ=""
COMMIT=""
SHA256=""
IMAGES=()
COMPOSE_BUNDLE=""
COMPOSE_REF=main
SERVICES=()
usage="usage: $0 --tarball <path> --commit <git-sha> --sha256 <digest> [--image <ref>]...
       [--compose-bundle <git-bundle> [--compose-ref <branch>] --compose-service <name>...]"
while [ $# -gt 0 ]; do
	case "$1" in
	--tarball) TGZ=${2:?--tarball needs a value}; shift 2 ;;
	--commit) COMMIT=${2:?--commit needs a value}; shift 2 ;;
	--sha256) SHA256=${2:?--sha256 needs a value}; shift 2 ;;
	--image) IMAGES+=("${2:?--image needs a value}"); shift 2 ;;
	--compose-bundle) COMPOSE_BUNDLE=${2:?--compose-bundle needs a value}; shift 2 ;;
	--compose-ref) COMPOSE_REF=${2:?--compose-ref needs a value}; shift 2 ;;
	--compose-service) SERVICES+=("${2:?--compose-service needs a value}"); shift 2 ;;
	*) echo "$usage" >&2; exit 2 ;;
	esac
done

# Validate all local inputs before changing the template.
[ -f "$TGZ" ] || { echo "tarball missing" >&2; exit 2; }
[[ "$COMMIT" =~ ^[0-9a-fA-F]{7,40}$ ]] || { echo "--commit must be a Git SHA" >&2; exit 2; }
[[ "$SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "--sha256 must be a SHA-256 digest" >&2; exit 2; }
ACTUAL_SHA256=$(sha256sum <"$TGZ")
[ "${ACTUAL_SHA256%% *}" = "$SHA256" ] || { echo "tarball SHA-256 mismatch" >&2; exit 1; }
if [ -n "$COMPOSE_BUNDLE" ]; then
	[ -f "$COMPOSE_BUNDLE" ] || { echo "compose bundle missing" >&2; exit 2; }
	[ ${#SERVICES[@]} -gt 0 ] || { echo "--compose-bundle needs at least one --compose-service" >&2; exit 2; }
elif [ ${#SERVICES[@]} -gt 0 ]; then
	echo "--compose-service needs --compose-bundle" >&2
	exit 2
fi

BUILT=$(incus query "/1.0/instances/$VM" | python3 -c 'import json, sys; print(json.load(sys.stdin)["created_at"])')

echo "== 1. VM must be running =="
incus start "$VM" 2>/dev/null || true
for _ in $(seq 1 90); do incus exec "$VM" -- true 2>/dev/null && break; sleep 1; done

echo "== 2. push the tarball =="
incus file push "$TGZ" "$VM/root/lance-nuit-0.1.0.tgz"
echo "$SHA256  /root/lance-nuit-0.1.0.tgz" | incus exec "$VM" -- tee /root/lance-nuit.sha256 >/dev/null
incus exec "$VM" -- sha256sum -c /root/lance-nuit.sha256

echo "== 3. drop the stale 'reprise' package =="
incus exec "$VM" -- npm uninstall -g reprise

echo "== 4. install lance-nuit from the clean commit =="
incus exec "$VM" -- npm install -g /root/lance-nuit-0.1.0.tgz
incus exec "$VM" -- bash -lc 'command -v lancenuit && lancenuit --help >/dev/null && echo "lancenuit OK"'

echo "== 5. current Claude Code CLI =="
# The runner passes flags that older CLIs reject; a template frozen for months
# fails the first agent step, not the provisioning.
incus exec "$VM" -- npm install -g @anthropic-ai/claude-code@latest
CLAUDE_VERSION=$(incus exec "$VM" -- bash -lc 'claude --version' | awk '{ print $1 }')

echo "== 6. no system-wide git hooks =="
# Earlier templates installed a pre-push guard through core.hooksPath. The VM
# has no remote, so it guarded nothing, and it silenced the project's own hooks.
incus exec "$VM" -- bash -c 'git config --system --unset-all core.hooksPath || true; rm -rf /etc/git-hooks'

echo "== 7. the 'nuit' user =="
# The agent runs unprivileged: Claude Code expects it for bypassPermissions,
# and the project's containers write files with the same UID. Docker group
# membership is root-equivalent inside the VM; the VM is the boundary.
incus exec "$VM" -- bash -c "
	getent group nuit >/dev/null || groupadd --gid $NUIT_ID nuit
	id nuit >/dev/null 2>&1 || useradd --uid $NUIT_ID --gid $NUIT_ID --create-home --shell /bin/bash nuit
	usermod -aG docker nuit"
incus exec "$VM" -- su - nuit -c 'id && command -v lancenuit claude bun git && docker info --format "docker {{.ServerVersion}}"'

echo "== 8. pre-pull Docker images =="
# A run VM starts from the snapshot: images pulled here are not fetched again
# every night, which costs minutes and Docker Hub's anonymous rate limit.
for image in "${IMAGES[@]}"; do
	incus exec "$VM" -- docker pull --quiet "$image"
done

COMPOSE_JSON=null
if [ -n "$COMPOSE_BUNDLE" ]; then
	echo "== 9. pre-build the project's Compose services =="
	# The night still runs `up --build`; this only bakes the layer cache. The
	# clone is a fresh checkout, so no vendor/ or node_modules/ ends up inside.
	incus file push "$COMPOSE_BUNDLE" "$VM/root/compose.bundle"
	incus exec "$VM" -- bash -c "rm -rf $PROJECT_DIR && git clone -q -b '$COMPOSE_REF' /root/compose.bundle $PROJECT_DIR"
	COMPOSE_SHA=$(incus exec "$VM" -- git -C "$PROJECT_DIR" rev-parse --short HEAD)
	incus exec "$VM" --cwd "$PROJECT_DIR" -- docker compose build "${SERVICES[@]}"
	incus exec "$VM" -- rm -rf "$PROJECT_DIR" /root/compose.bundle
	COMPOSE_JSON=$(printf '%s\n' "$COMPOSE_REF" "$COMPOSE_SHA" "${SERVICES[@]}" | python3 -c '
import json, sys
ref, sha, *services = sys.stdin.read().splitlines()
print(json.dumps({"ref": ref, "commit": sha, "services": services}))')
fi
incus exec "$VM" -- docker image ls --format '{{.Repository}}:{{.Tag}}'
IMAGES_JSON=$(printf '%s\n' "${IMAGES[@]}" | python3 -c 'import json, sys; print(json.dumps([l for l in sys.stdin.read().splitlines() if l]))')

echo "== 10. record provenance =="
incus exec "$VM" -- tee /etc/nuit-template.json >/dev/null <<JSON
{
  "built": "$BUILT",
  "base": "images:debian/12",
  "provisioned": "$(date -Iseconds)",
  "lance_nuit_commit": "$COMMIT",
  "lance_nuit_source": "operator-supplied tarball verified by SHA-256",
  "lance_nuit_sha256": "$SHA256",
  "claude_code_version": "$CLAUDE_VERSION",
  "agent_user": "nuit:$NUIT_ID:$NUIT_ID",
  "docker_images": $IMAGES_JSON,
  "compose_build": $COMPOSE_JSON
}
JSON
incus exec "$VM" -- cat /etc/nuit-template.json

echo "== 11. remove the tarball, then snapshot =="
incus exec "$VM" -- rm -f /root/lance-nuit-0.1.0.tgz /root/lance-nuit.sha256
incus stop "$VM"
incus snapshot rename "$VM" clean "clean-$(date +%Y%m%d-%H%M%S)-pre-provision"
incus snapshot create "$VM" clean
incus info "$VM" | sed -n '/napshot/,$p'

echo
echo "Done. Snapshot 'clean' now carries lance-nuit $COMMIT."
