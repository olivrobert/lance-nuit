#!/usr/bin/env bash
# Harden nuit-template: no forge credentials, no real forge CLI, no web tools.
# `gh` becomes a shim onto the host broker (ticket 11). Run from the host, no sudo.
set -euo pipefail

VM=nuit-template

incus start "$VM" 2>/dev/null || true
for _ in $(seq 1 90); do incus exec "$VM" -- true 2>/dev/null && break; sleep 1; done

echo "== 1. remove the forge CLIs =="
# gh comes from the github-cli apt repository; the repo goes too, so that an
# `apt update && apt install gh` inside the VM cannot silently bring it back.
# Idempotent: a second hardening run finds gh already purged, and a plain
# `apt-get purge` fails there, stopping the script before the new snapshot.
incus exec "$VM" -- bash -lc 'if dpkg -s gh >/dev/null 2>&1; then apt-get purge -y gh; else echo "gh: already absent"; fi'
incus exec "$VM" -- rm -f /etc/apt/sources.list.d/github-cli.list
incus exec "$VM" -- rm -f /usr/local/bin/glab /usr/local/bin/acli
incus exec "$VM" -- apt-get autoremove -y

echo "== 2. put the brokered gh in its place =="
# The VM keeps a `gh` on its PATH, but it is a shim: it forwards the argument
# list to the host broker, which holds the credential and accepts only the five
# `gh issue` shapes the lance-nuit adapter emits. The adapter cannot tell the
# difference -- it only reads stdout, stderr and the exit code.
incus file push "$(dirname "$0")/broker/gh-shim" "$VM/usr/local/bin/gh" --mode 0755

echo "-- what is on PATH now --"
incus exec "$VM" -- bash -lc 'for b in gh glab acli git curl ssh; do printf "%-6s %s\n" "$b" "$(command -v $b || echo ABSENT)"; done; echo "gh is the shim:"; head -2 "$(command -v gh)" | tail -1'

echo "== 3. cut the web tools of the agent CLIs =="
# Defence in depth only. The real lock is the network ACL: a destination that is
# not reachable is not reachable whatever the tool. These settings just stop the
# agent from wasting the night retrying.
incus exec "$VM" -- mkdir -p /root/.claude /root/.codex /root/.config/opencode

incus exec "$VM" -- bash -lc 'cat > /root/.claude/settings.json <<JSON
{
  "permissions": {
    "deny": ["WebFetch", "WebSearch"]
  }
}
JSON'

incus exec "$VM" -- bash -lc 'cat > /root/.codex/config.toml <<TOML
[tools]
web_search = false
TOML'

incus exec "$VM" -- bash -lc 'cat > /root/.config/opencode/opencode.json <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "tools": {
    "webfetch": false
  }
}
JSON'

incus exec "$VM" -- bash -lc 'echo "--- claude ---"; cat /root/.claude/settings.json; echo "--- codex ---"; cat /root/.codex/config.toml; echo "--- opencode ---"; cat /root/.config/opencode/opencode.json'

echo "== 4. snapshot =="
incus stop "$VM"
# Dated at run time: a hardcoded name collides with the snapshot a previous
# run already left behind, and `set -e` would stop before the new `clean`.
incus snapshot rename "$VM" clean "clean-$(date +%Y%m%d-%H%M%S)-pre-hardening"
incus snapshot create "$VM" clean
incus info "$VM" | sed -n '/napshot/,$p'

echo
echo "Done. Forge CLIs gone, agent web tools denied, snapshot 'clean' refreshed."
