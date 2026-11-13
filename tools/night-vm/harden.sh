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
# They belong to 'nuit', the user the agent runs as; earlier templates wrote
# them under /root, where they are removed.
incus exec "$VM" -- id nuit >/dev/null || { echo "no 'nuit' user: run provision-template.sh first" >&2; exit 1; }
incus exec "$VM" -- rm -f /root/.claude/settings.json /root/.codex/config.toml /root/.config/opencode/opencode.json

incus exec "$VM" -- su - nuit -c 'mkdir -p ~/.claude ~/.codex ~/.config/opencode
cat > ~/.claude/settings.json <<JSON
{
  "permissions": {
    "deny": ["WebFetch", "WebSearch"]
  }
}
JSON
cat > ~/.codex/config.toml <<TOML
[tools]
web_search = false
TOML
cat > ~/.config/opencode/opencode.json <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "tools": {
    "webfetch": false
  }
}
JSON'

incus exec "$VM" -- su - nuit -c 'echo "--- claude ---"; cat ~/.claude/settings.json; echo "--- codex ---"; cat ~/.codex/config.toml; echo "--- opencode ---"; cat ~/.config/opencode/opencode.json'

echo "== 4. snapshot =="
incus stop "$VM"
# Dated at run time: a hardcoded name collides with the snapshot a previous
# run already left behind, and `set -e` would stop before the new `clean`.
incus snapshot rename "$VM" clean "clean-$(date +%Y%m%d-%H%M%S)-pre-hardening"
incus snapshot create "$VM" clean
incus info "$VM" | sed -n '/napshot/,$p'

echo
echo "Done. Forge CLIs gone, agent web tools denied, snapshot 'clean' refreshed."
