# Night VM — running lance-nuit in a confined Incus VM

An unattended run is given a project, a work item, and hours of autonomy. This
directory holds what keeps that run inside a box: a throwaway Incus VM with no
forge credential, a network ACL, and a broker that lends the VM a handful of
`gh issue` operations without ever lending it the token.

This file is the operating manual — **what to type**. The design notes, the
tickets, and the current state of the local VM fleet live outside the repository,
under `.scratch/pipelines-nuit-vm/` on the maintainer's machine.

## The pieces

| File | Role | Runs on |
|---|---|---|
| `provision-template.sh` | (re)installs `lancenuit` and the `pre-push` hook, refreshes the `clean` snapshot | host |
| `harden.sh` | removes `gh`/`glab`/`acli`, installs the `gh` shim, denies the agents' web tools, refreshes `clean` | host |
| `network-acl.sh` | creates / applies / tests the `nuit` ACL | host |
| `night-run.sh` | keeps the broker alive for exactly the length of one run | host |
| `broker/gh-broker.py` | relays five `gh issue` shapes using the host's credential | host |
| `broker/gh-shim` | the fake `gh` installed in the VM; talks to the broker | VM |
| `pre-push` | refuses pushes to `main`/`master`/`develop`/`production` | VM |
| `incus-docker-forward.service` | restores IPv4 egress on both bridges, which Docker's `FORWARD DROP` breaks | host |

The reference template is a VM named `nuit-template` holding Debian 12, Docker,
Node 22, bun, the three agent CLIs, `lancenuit`, and the `pre-push` hook. Runs
never use it directly: each run is a throwaway copy of its `clean` snapshot.

## Basic gestures

```sh
incus list                                    # what exists
incus start nuit-template
incus exec nuit-template -- bash              # root shell inside
incus stop nuit-template

incus snapshot list nuit-template
incus snapshot restore nuit-template clean    # back to the reference state
```

A VM takes about 15 s to answer after `start`. To wait for it properly:

```sh
for _ in $(seq 1 90); do incus exec <vm> -- true 2>/dev/null && break; sleep 1; done
```

## Making a run VM

```sh
incus copy nuit-template/clean nuit-run-01    # ~15 s
incus start nuit-run-01                       # ~14 s until Docker is ready
```

Destroy it afterwards — run clones are not kept:

```sh
incus delete nuit-run-01 --force
```

## One-time setup

To refresh the runner in an existing template, supply a verified tarball and
its source commit (see [package verification](../../CONTRIBUTING.md#package-readiness)):

```sh
./provision-template.sh --tarball /path/to/lance-nuit-0.1.0.tgz \
  --commit <git-sha> --sha256 <verified-sha256>
```

The script checks the inputs before changing the VM and installs `pre-push`
from this directory. It preserves the previous `clean` snapshot under a dated name.

```sh
./harden.sh                    # hardening + gh shim + new 'clean' snapshot
./network-acl.sh create        # creates the 'nuit' ACL
```

Then, on every run VM:

```sh
./network-acl.sh apply nuit-run-01     # before `incus start`
./network-acl.sh test  nuit-run-01     # HTTPS passes, outbound SSH is blocked
```

`create` builds two things: the `nuit` ACL, and `nuitbr0`, the bridge that
carries it. On a bridge network — unlike OVN — `security.acls` is an option of
the *network*, not of the NIC, so an ACL on `incusbr0` would apply to every
instance on it, the template included and while it is being provisioned. Hence a
bridge of its own, with IPv6 off: a dual-stacked VM reaches AAAA-only routes
even when its IPv4 path is down, which hides exactly the kind of break this
setup must surface.

`apply` therefore moves the run VM's NIC onto `nuitbr0`. **Do it before the first
boot**: the VM's address changes with the bridge, and the gateway becomes
`10.174.226.1`.

The ACL filters on address, protocol and port, not on domain names: 80/443 stay
open to the world, DNS and the broker port range (8099-8199) are allowed towards
the gateway only, and everything else is refused. That already removes outbound
SSH, so `git@github.com:` is dead inside the VM.

The broker rule is not optional: without it the shim cannot reach the host once
the VM is on the ACL'd bridge, and every `gh` call exits 127. Docker's
`FORWARD DROP` applies to the new bridge too, so
`incus-docker-forward.service` — which now covers both bridges — must be
reinstalled if it predates it.

## The broker during a run

`night-run.sh` does one thing: keep the broker alive for exactly the length of
the run. The broker carries the credential, so it must not outlive the run — it
is started as a child process and killed by the `EXIT` trap, including on Ctrl-C
and on a failing command.

```sh
./night-run.sh --vm nuit-run-01 --repo owner/name -- <run command>
./night-run.sh --vm nuit-run-01 --repo owner/name       # no command: holds
                                                        # until Ctrl-C
```

Before starting, it checks the three things that would otherwise only surface in
the morning: the host `gh` is authenticated, the VM answers, the port is free.

**One broker per run.** `--repo` is imposed when the broker starts, so two runs
on two repositories need two instances, hence two ports. The port is derived from
the numeric suffix of the VM name — `nuit-run-01` → 8100, `nuit-run-02` → 8101 —
and `--port` overrides it. The endpoint is written into the VM at
`/etc/lance-nuit/gh-broker.url`, which the shim reads (`GH_BROKER_URL` overrides it,
otherwise `http://10.174.226.1:8099/gh`). A port already taken fails the startup:
two runs do not share one credential scope.

Each run also generates a random broker credential, installed only in that VM
at `/etc/lance-nuit/gh-broker.token` with mode `0600`. The broker requires it on
every request, so reaching another run's port does not grant access to its
repository. This credential is not a GitHub token. The host's temporary copy is
removed on exit; a new run rotates it. `GH_BROKER_TOKEN_FILE` overrides the shim's
credential path for local tests. Restarting with an older shim requires running
`harden.sh` or installing the updated shim first.

**Journal.** The `ALLOWED`/`REFUSED` verdicts go to `<run-dir>/gh-broker.log`,
under `~/.lance-nuit/night-runs/<vm>-<timestamp>/` by default. On shutdown the
script prints the counts and the last five refusals: that is the first thing to
read in the morning.

## Checking the `gh` shim from inside a VM

```sh
./test-broker-vm.sh
```

Self-contained: throwaway clone of the template, shim pushed into it, broker
started on the gateway, everything torn down at the end. It does not assume
`harden.sh` has run and does not touch the template. Read-only — nothing is
written to the repository.

What it proves, in order: the host `gh` is authenticated; the VM resolves its
endpoint from `/etc/lance-nuit/gh-broker.url` and reads real issues through the
shim; `gh auth token`, `gh api`, `gh repo clone`, another repository,
`issue delete` and `issue edit --body` are refused; no token-looking string is
left in the VM; and with the broker down the shim exits **127** with a clear
message — the code lance-nuit reads as "binary missing", so a clean failure
rather than a retry loop. A last round runs the same read under `night-run.sh`
and checks that the verdicts were journalled and that the broker died with the
run.

Options: `--repo owner/name` to target another repository, `--acl` to apply the
`nuit` ACL to the throwaway VM first — the only way to prove the ACL lets the VM
reach the broker — and `--keep` to keep the VM and dig around.

Each invocation uses a unique VM name and only deletes the clone it created.
The SSH check probes TCP port 22 without authenticating; DNS and probe errors
fail the test instead of counting as a blocked connection.

Local regression tests need Python 3 and Node.js, but no VM or GitHub access:

```sh
python3 -B -m unittest discover -s tools/night-vm -p 'test_*.py'
```

## A night, end to end

The sequence below is still manual; the `lancenuit` wrapper is meant to
encapsulate it. Steps 2 to 6 run under `night-run.sh`, which frames the broker,
so there is no `kill` to do by hand.

```sh
# 1. the VM
incus copy nuit-template/clean nuit-run-01
./network-acl.sh apply nuit-run-01              # before the first boot
incus start nuit-run-01

# 2. the code (a bundle) and the unversioned context
cd <project>
BASE=$(git branch --show-current)        # the branch the run starts from
git bundle create /tmp/run.bundle "$BASE"
tar czf /tmp/payload.tgz CLAUDE.md .lance-nuit/work-items/<ticket>
incus file push /tmp/run.bundle /tmp/payload.tgz nuit-run-01/root/

# 3. inside the VM
incus exec nuit-run-01 -- bash -lc '
  git init -q /tmp/verify &&
  git -C /tmp/verify bundle verify /root/run.bundle &&
  rm -rf /tmp/verify &&
  git clone -b <base> /root/run.bundle /srv/project &&
  cd /srv/project && git remote remove origin &&
  tar xzf /root/payload.tgz -C /srv/project'

# 4. the secrets: read-only disk device from /dev/shm -- still to wire
# 5. the run: lancenuit inside the VM
# 6. in the morning
incus exec nuit-run-01 -- bash -lc 'cd /srv/project && git bundle create /root/out.bundle <base>..nuit/<ticket>'
incus file pull nuit-run-01/root/out.bundle /tmp/
cd <project>
git fetch /tmp/out.bundle nuit/<ticket>
git log --stat FETCH_HEAD                       # look BEFORE publishing
git push origin FETCH_HEAD:refs/heads/nuit/<ticket>

# 7. cleanup
incus delete nuit-run-01 --force
```

A bundle is used rather than a copy of the clone on purpose: a copy carries the
GitHub remote with it, which is exactly what the confinement forbids.

Name the base branch explicitly, in the bundle and in the clone: a bundle that
carries only `HEAD` clones into a detached state, with no branch for the run to
build on. And `git bundle verify` needs a repository to compare prerequisites
against, hence the throwaway one above — it must come before the clone to be a
gate rather than a formality.

## Troubleshooting

**No IPv4 egress in the VM** (pinging the gateway works, `curl` times out).
Docker sets `FORWARD DROP` on the host and drops `incusbr0` traffic.

```sh
systemctl is-active incus-docker-forward.service   # must say 'active'
sudo systemctl restart incus-docker-forward.service
```

Trap: a `docker pull` **still succeeds** in that state, because Docker Hub has
AAAA records — it falls back to IPv6 and proves nothing. Test with
`curl -4 https://github.com`, which has none.

**`incus` answers "permission denied"**: membership of the `incus-admin` group
only takes effect in the next session. Otherwise `sudo incus`.

**"QEMU command not available"**: `sudo systemctl restart incus` after installing
QEMU.

**The `gh` shim answers "broker unreachable"**: the broker is not running on the
host, the ACL blocks the port, or the VM points at the wrong port. Check, in that
order, `cat /etc/lance-nuit/gh-broker.url` inside the VM and the port announced
by `night-run.sh`. The shim exits 127, which lance-nuit reads as "binary
missing".
