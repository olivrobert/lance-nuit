#!/usr/bin/env bash
# Provision nuit-template: clean lance-nuit install + pre-push guard.
# Run from the host, no sudo needed.
set -euo pipefail

VM=nuit-template
HERE=$(cd "$(dirname "$0")" && pwd)
TGZ=""
COMMIT=""
SHA256=""
while [ $# -gt 0 ]; do
	case "$1" in
	--tarball) TGZ=${2:?--tarball needs a value}; shift 2 ;;
	--commit) COMMIT=${2:?--commit needs a value}; shift 2 ;;
	--sha256) SHA256=${2:?--sha256 needs a value}; shift 2 ;;
	*) echo "usage: $0 --tarball <path> --commit <git-sha> --sha256 <digest>" >&2; exit 2 ;;
	esac
done

# Validate all local inputs before changing the template.
[ -f "$TGZ" ] && [ -r "$HERE/pre-push" ] || { echo "tarball or pre-push hook missing" >&2; exit 2; }
[[ "$COMMIT" =~ ^[0-9a-fA-F]{7,40}$ ]] || { echo "--commit must be a Git SHA" >&2; exit 2; }
[[ "$SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "--sha256 must be a SHA-256 digest" >&2; exit 2; }
ACTUAL_SHA256=$(sha256sum <"$TGZ")
[ "${ACTUAL_SHA256%% *}" = "$SHA256" ] || { echo "tarball SHA-256 mismatch" >&2; exit 1; }

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

echo "== 5. pre-push guard, global to every clone in the VM =="
incus exec "$VM" -- mkdir -p /etc/git-hooks
incus file push "$HERE/pre-push" "$VM/etc/git-hooks/pre-push" --mode 0755
incus exec "$VM" -- git config --system core.hooksPath /etc/git-hooks
incus exec "$VM" -- git config --system --get core.hooksPath

echo "== 6. record provenance =="
incus exec "$VM" -- bash -lc "cat > /etc/nuit-template.json <<JSON
{
  \"built\": \"2026-08-30T20:08:22+00:00\",
  \"base\": \"images:debian/12\",
  \"provisioned\": \"$(date -Iseconds)\",
  \"lance_nuit_commit\": \"$COMMIT\",
  \"lance_nuit_source\": \"operator-supplied tarball verified by SHA-256\",
  \"lance_nuit_sha256\": \"$SHA256\",
  \"pre_push_guard\": \"/etc/git-hooks/pre-push via core.hooksPath\"
}
JSON"
incus exec "$VM" -- cat /etc/nuit-template.json

echo "== 7. remove the tarball, then snapshot =="
incus exec "$VM" -- rm -f /root/lance-nuit-0.1.0.tgz /root/lance-nuit.sha256
incus stop "$VM"
incus snapshot rename "$VM" clean "clean-$(date +%Y%m%d-%H%M%S)-pre-provision"
incus snapshot create "$VM" clean
incus info "$VM" | sed -n '/napshot/,$p'

echo
echo "Done. Snapshot 'clean' now carries lance-nuit $COMMIT."
