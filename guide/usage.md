# Usage

This guide describes using the installed npm package or a source checkout. The runner
orchestrates a TypeScript definition and external capabilities (skills or
agents); it assumes neither an application framework nor a tracker.

## Installation

The runner executes on [Bun](https://bun.sh) 1.3 or newer, which loads the
TypeScript pipelines directly. `bin/lancenuit` resolves `bun` on the `PATH` and,
when it finds none, prints an install hint and exits with status 127. The
`engines.bun` field of `package.json` records the same floor, but neither npm nor
Bun enforces that field: the wrapper checks the executable's presence. Install
Bun separately and pin its version in unattended environments. Linux is verified
in CI. The wrapper requires Bash 4+ (including on macOS); native Windows is not
supported, so use a Linux environment there.

```bash
curl -fsSL https://bun.sh/install | bash   # macOS/Linux, then open a new shell
brew install oven-sh/bun/bun               # Homebrew
mise use -g bun@1.3                        # version manager, pins the version
bun --version                              # must report 1.3 or newer
```

The simplest route is a checkout: Bun loads the TypeScript sources directly, so
there is nothing to build. See [Use a checkout](#use-a-checkout). A tarball is
for machines that carry no checkout.

### Install a package

Before registry publication, there is no tarball to download: build one from a
checkout. `prepack` runs the build, so `npm pack` is enough.

```bash
cd /path/to/lance-nuit
bun install --frozen-lockfile
npm pack                                # writes lance-nuit-<version>.tgz here
```

Then install that file in the target project:

```bash
npm install --save-dev --save-exact /path/to/lance-nuit-0.1.0.tgz
export PATH="$PWD/node_modules/.bin:$PATH"
lancenuit --version
```

The installed wrapper executes `dist/runner.js`; no source checkout, build tools,
or package lifecycle scripts are needed at runtime. Keep the project lockfile and
the tarball available when reproducing an installation. If a VM omits development
dependencies, install the runner as a regular dependency or in its own tool project.

After a registry release exists, the tarball path can be replaced with an exact
`lance-nuit@<version>` package specifier. Avoid installing a moving tag at the start
of a nightly run.

### Install once per machine

The runner is built around a shared kit, `~/.lance-nuit/`, that every project
on the machine inherits (see [kit paths](kit-paths.md)). One CLI per machine
fits that model:

```bash
npm install --global /path/to/lance-nuit-0.1.0.tgz   # or: lance-nuit@<version>
lancenuit --version
lancenuit types install --user                        # equip the shared kit once
```

A machine that has no npm — the supported case, since the runner needs only Bun —
links the wrapper from a checkout instead, into a directory already on the `PATH`:

```bash
ln -s /path/to/lance-nuit/bin/lancenuit ~/.local/bin/lancenuit
lancenuit types install --user
```

The wrapper resolves its own directory through the link, so it keeps running the
checkout's sources and follows every edit without a rebuild. Prefer this to
exporting `PATH` from a shell profile: an export lives in the shell that ran it,
and a `lancenuit` missing from a fresh terminal — or from an editor task — sends
the reader looking for an installation problem that is not there.

Projects then need no `lance-nuit` dependency of their own. `lancenuit create`
and `lancenuit types install` equip each project kit with the DSL declarations
and with a vendored copy of `lance-nuit/contracts`, so an extension inside
`.lance-nuit/` or `~/.lance-nuit/` imports the contracts of the CLI that loads
it; a run refreshes that copy when the CLI changes. See
[core contract and extensions](packages-and-extensions.md#how-a-kit-extension-resolves-lance-nuitcontracts).
A project-local install remains possible when a project must pin its own CLI
version; the kit copy takes precedence for the kit's extensions either way.

To build and verify a distributable tarball from a checkout:

```bash
bun install --frozen-lockfile
VERIFY_TARBALL_DEST=/tmp/lance-nuit-package bun run verify:production
```

This downloads runtime dependencies in a clean temporary consumer, tests the
installed CLI, DSL declarations, extension contracts and failure/resume behavior,
then copies the tested tarball to the requested directory. It does not publish.
See [Contributing](../CONTRIBUTING.md#package-readiness) for the complete checks.

### Use a checkout

Install the checkout's dependencies, then put the wrapper on the `PATH`:

```bash
cd /path/to/lance-nuit
bun install --frozen-lockfile
export PATH="$PWD/bin:$PATH"
# Then run `lancenuit ...` from the root of the project being orchestrated.
```

A checkout runs its sources: the wrapper ignores the git-ignored `dist/` on
purpose, since it goes stale as soon as a source changes. `lancenuit create` and
`lancenuit types install` still equip a project kit exactly as a published
install does — the DSL declarations under `.lance-nuit/.lance-nuit-types/` and
the vendored contracts under `.lance-nuit/node_modules/lance-nuit/`, compiled
from `src/contracts/**` on the fly. No build step is involved.

Bun installs checkout dependencies from the single `bun.lock`. Node.js 22+ and
npm are still required for packaging verification, and for nothing else; see
[Contributing](../CONTRIBUTING.md#setup) and [Lockfiles](#lockfiles) below.

Working on the runner itself goes through Bun as well:

```bash
bun test
bun run typecheck
```

## Invocation

`lancenuit version` and `lancenuit --version` print the installed package version
without loading a project configuration or starting a run.

The wrapper exposes a generic run command and never assumes an application
tracker or a project-specific preset:

```bash
lancenuit run PROJ-28                         # the resolved `default` pipeline
lancenuit single PROJ-28                      # same pipeline, no dispatch loop
lancenuit run PROJ-28 --pipeline release      # a project/shared pipeline by name
lancenuit run PROJ-28 --pipeline .lance-nuit/pipelines/release.ts
```

`--scan` is a low-level runner mode for a pipeline that declares a scannable
`forEachWorkItem` source; it discovers tickets instead of taking a positional
ticket. See [the DSL guide](dsl.md) for the declaration.

Diagnostic and administration commands:

```bash
lancenuit list
lancenuit help
lancenuit inspect PROJ-28
lancenuit logs PROJ-28 --step tests
lancenuit clean --logs-only --older-than 30d
lancenuit typecheck
lancenuit types install
lancenuit lint -p release
lancenuit create release --command 'make release-check'
```

For an explicit definition:

```bash
lancenuit run PROJ-28 --pipeline .lance-nuit/pipelines/release.ts
bun /path/to/lance-nuit/src/runner.ts PROJ-28 --pipeline .lance-nuit/pipelines/release.ts
RUNNER_DISABLE_DISPATCH=1 bun /path/to/lance-nuit/src/runner.ts PROJ-28-01
bun /path/to/lance-nuit/src/runner.ts --scan --pipeline queue
```

## Dashboard

`lancenuit ui [--port <n>]` serves a local dashboard on `127.0.0.1` only (build
it once with `bun run ui:build` in a checkout). Reach it from another machine
through an SSH tunnel that keeps the same port on both ends:
`ssh -L <n>:127.0.0.1:<n> <host>`. Names allowed to act are listed by hand in
`~/.lance-nuit/ui/users.json` (`{"users": ["Olivier"]}`); projects are added
from the dashboard or in `~/.lance-nuit/ui/projects.json`.

### Review inbox

The list holds every run, in the order a morning reader goes through it:

- **Needs you**: runs stopped for a decision, then technical failures;
- **Running**: runs in progress;
- one section per night for the finished runs. A night starts at 18:00 local
  time and runs until 18:00 the next day. The current night is **Tonight** once
  it started today and **Last night** in the morning, the one before it
  **Yesterday** (or **Last night** in the evening), the six nights before that
  are merged into **This week**, and anything older goes to **Earlier**, folded
  by default. Each night section gives its dates, its run count, and its cost.

Empty sections are not shown. Inside a section the newest run comes first. A
row leads with the ticket title, the first `# ` heading of the work item's
`artifacts/ticket.md` without a leading `<key> — ` the provider may have
written into it, and falls back to the ticket key when that file has none; the
key, the pipeline, and the time follow on the line below. The time
is an age in **Needs you** and **Running**, a clock in a night, a weekday and a
clock in **This week**, and a date in **Earlier**. A row carries a tag only for
an exception (`FAIL`, `STOPPED`, `ABORTED`, `CLOSED`, a run in progress), and a
project badge only when no project is selected and the rows span several
projects.

The chips above the list jump to a section, opening it when it is folded; they
do not filter. The search box and the project chips filter every section. The
folded or open state of a night survives the periodic refresh. `j` or `↓` and
`k` or `↑` move the selection over the rows on screen, `/` focuses the search,
and `Escape` in the search clears it and returns to the list. These keys are
ignored while typing in a field, while a dialog is open, on the terminal
screen, and with a modifier key. Outside the list, in the sheet or a file view,
the arrows keep scrolling the page; only `j` and `k` move the selection there.

A run waiting for a decision opens with its question above the tabs: the
reason it stopped, the approval to give when the step asks for one, and
**Answer on the ticket instead** to reply without approving.

The dashboard reads the server every 15 seconds, and every 60 seconds while
its tab is in the background. Coming back to the tab reads the server at once.
The banner says when the list was last updated, and warns when the server has
stopped answering: the list then keeps what it last received.

**Notify me** in the banner asks the browser for permission to show
notifications. Once granted, the dashboard notifies each run that newly needs a
decision or failed, only while its tab is in the background. Clicking the
notification opens that run. Browsers allow notifications on `127.0.0.1` and
`localhost`, which the SSH tunnel preserves.

### Run sheet

Selecting a run opens its sheet. The header is the same for every run: the
project, ticket key, pipeline, and short run id, with links to the ticket and
to the run's terminal; the ticket title (or its key); and a verdict line. A
passed run that was not closed says **Delivered**, when it finished in your
local time, how long it took from the first to the last write of its snapshot,
and its cost. Any other run keeps its status tag and the reason it stopped.

A delivered run whose [delivery report](work-item-layout.md#delivery-report-artifactsreportjson)
names a primary link leads with it (typically **Open merge request**), followed
by a copy button for the value the report marks as copyable, such as the
branch. Rerun, Start fresh, and Mark as closed then move under **More
actions**. Without a report, the actions are the usual ones.

The tabs are **Report**, **Run**, and **Files**, plus **Diagnostic** for a
failure or a launch and **Document** when the run has a document to show. A
tab with nothing to show is not listed. A finished run opens on **Report** when
its current run wrote a valid `report.json`, and on **Run** otherwise; a
running run opens on **Run**, a failure on **Diagnostic**, and a run waiting
for a decision on its **Document**. A `report.json` the dashboard rejected
leaves one line with the reason in place of the Report tab.

The **Report** tab shows, each block only when the report fills it: **Left for
you** (follow-ups and the reserve of every criterion that has one), what was
**Delivered** with the report's other links, the **acceptance criteria** with
their met count, proofs, and screenshots (a criterion not met or with a reserve
is open by default), the **screenshots** labelled with their criteria, the
points **for review** with a Copy button, and folded **notes** that open their
file in the Files tab. The content is shown as the pipeline wrote it; the
dashboard never reads a status out of the markdown reports, which stay in
Files.

The **Files** tab lists each directory with the markdown documents first, then
the other files, then the runner's own files (`*.json`, `*.sha`,
`.provenance/`, `runs/`) folded under **Machine files**. **Run details**, below
the tab content, holds the run's identity, its last launch, its approval, and
its assumptions.

### Run tab

The **Run** tab shows where the time went:

- three figures: the time elapsed between the first and last write of the
  snapshot (pauses included, with the clock times), the cost, and the tokens
  in and out (with the share read from cache);
- a timeline: one lane per step that took at least a second, cost money,
  failed, or is still running, placed over the run span by its start and end.
  The bar is the step's wall time; the Duration and Cost columns repeat it with
  the step's cost. Shorter
  steps share one lane of ticks, and skipped steps are listed under it;
- the cost by model. A step that composes pipelines (`runPipeline`,
  `forEachPipeline`) ran no model of its own: its cost is split by the models
  its child runs used;
- the screenshots found under the work item's `reports/`, grouped by
  directory, unless the run's report lists its own screenshots. A `summary.md`
  or `report.md` next to the images opens in the Files tab.

Every figure comes from the run's `state.json`, the ledger the budget is
enforced against. The tab only displays those figures and never sums them.
Images are served as raw bytes by
`GET /api/items/<project>/<ticket>/raw?path=<relative path>`, and only files
with an image extension are served this way.

### Launch an interactive run

**Launch a run** opens a dialog: the ticket, the pipeline (listed from the
project's kit chain), and whether to use a worktree. When a project chip is
selected the dialog is locked to it. A ticket must start with the project's
declared key (`food-12` is accepted as `FOOD-12` on a `FOOD` project, a
`PACASEC-3` is refused there). The server validates the
ticket through the project's work-item provider, refuses an item whose run is
already in progress, then starts a tmux session in the project's main clone,
running your `$SHELL`, and types into it:

```bash
claude --agent lancenuit-operator 'Lance la pipeline : lancenuit run PROJ-28 --pipeline default --worktree'
```

The `claude` CLI must be on the dashboard's `PATH` (otherwise the launch is
refused with 503), and a `lancenuit-operator` agent must be defined in your
Claude configuration. The agent drives the run and answers in the pane; when it
exits, the shell stays open.

The dashboard then shows the session in an embedded terminal you can type into.
Closing the page only detaches; the session keeps running. The same session is
reachable from any shell on the machine:

```bash
tmux -L lancenuit attach -t ln-<project>-<ticket>
```

Sessions live on a dedicated tmux socket (`-L lancenuit`), so your own tmux
server is never touched. tmux is the only record: a session killed from a shell
disappears from the dashboard, and a restarted dashboard finds every session
still there. One session per project and ticket; a second launch is refused
while the first one is open.

**Security.** The embedded terminal is a shell. Every terminal request needs a
declared name and a same-origin request, every `/api/*` request must carry
`Host: 127.0.0.1:<port>` or `localhost:<port>` (which blocks DNS rebinding),
and typing into a terminal needs the viewer token its stream handed out.
Anyone who can reach the port with a declared name can type into a shell as
the user running the dashboard: keep it on loopback and behind the tunnel.

## Project configuration

The canonical configuration is `.lance-nuit/config.json`. A user configuration
can provide defaults in `~/.lance-nuit/config.json`.

Minimal layout:

```text
project/
├── .lance-nuit/
│   ├── config.json
│   ├── pipelines/*.ts
│   └── prompts/                 optional prompt files
└── .claude/
    ├── skills/             project capabilities
    ├── agents/             project agents
    └── sessions/            Claude Code session data
```

The runner ships [`examples/builtin-reviews`](../examples/builtin-reviews/README.md)
as a TypeScript reference for the former builtin review entries. Copy the steps
you need into a project pipeline and change them there; quality steps are regular
TypeScript definitions with no runtime family discovery.

## External capabilities

Slash-command `llmStep`s and agent-backed steps are intentionally decoupled from
the runner. Capability preflight verifies that every referenced capability exists
before the first spawn.

In a standalone checkout, the runner uses its own root (useful when neighboring
capabilities are installed), then:

- `<project>/.claude`;
- `~/.claude`.

If plugins live elsewhere, add their roots to `PIPELINE_CAPABILITY_ROOTS` (paths
separated by `:` on Unix and `;` on Windows):

```bash
export PIPELINE_CAPABILITY_ROOTS="/opt/my-capabilities:/srv/team-capabilities"
```

The variable applies to preflight and to `model`, `effort`, and `context`
frontmatter lookup.

## Common options

```bash
lancenuit run PROJ-28 --watch
lancenuit run PROJ-28 --watch --watch-auto-close
lancenuit run PROJ-28 --fresh
lancenuit run PROJ-28 --pipeline .lance-nuit/pipelines/release.ts --steps lint,tests
lancenuit run PROJ-28 --pipeline .lance-nuit/pipelines/release.ts --skip tests
lancenuit run PROJ-28 --start-at tests
lancenuit run PROJ-28 --allow-dirty
lancenuit run PROJ-28 --worktree
```

- `--fresh` ignores the last resumable run.
- If `latest` names a run whose snapshot is missing, corrupt, or incompatible,
  the invocation fails before executing a step and leaves that selector and run
  directory unchanged. Inspect or restore the named snapshot, or pass
  `--fresh` deliberately to start a separate run.
- `--watch` opens a tmux pane when tmux is available; the pane stays open by
  default and `--watch-auto-close` closes it after a terminal run.
- `--steps` and `--skip` filter step IDs.
- `--start-at` skips every step before the named step; it is exclusive with the
  other selectors.
- On a **resumed** run the selectors are durable, not a one-off view: every step
  they leave out is written to the snapshot as `skipped`. Once no step remains,
  the run finalizes as `PASS` and counts as complete — `--scan` will not pick the
  work item up again. Use `--fresh` to replay the whole pipeline instead.
- `--scan` discovers work items, and `--limit` caps the number discovered.
- `--allow-dirty` disables the clean-tree guard for the current run.
- `--worktree` isolates the run in a dedicated Git worktree.

## Execution guarantees

- **Project lock**: one top-level runner writes a cwd's state at a time. Child
  runners inherit the parent's lock.
- **Clean tree**: a fresh run rejects uncommitted changes unless the pipeline
  permits a dirty tree or `--allow-dirty` is used.
- **Atomic persistence**: state is written to a temporary file and then renamed.
- **Resume**: the last compatible run is resumed; attempts and output remain in
  the work-item directory.
- **Explicit verdict**: an agent step must produce a verdict; a bash step is
  evaluated by its exit code.

By default, work-item artifacts and run state are under
`.lance-nuit/work-items/<ticket>/`. Within that directory, snapshots live in
`runs/<pipeline>/<runId>/state.json` and step logs in the corresponding
`steps/.../output.log`. A configuration `specPath` moves the work-item root.

## Worktrees

`--worktree` creates or reuses a worktree for the ticket and changes the run cwd.
The main checkout remains available to an IDE or another run. It is not
supported together with `--scan`; scan tickets are isolated by the dispatch
strategy instead.

The runner does not provide a universal application stack. A project can define
`.lance-nuit/worktree-init.sh` (one-time initialization) and/or an idempotent
`.lance-nuit/worktree-setup.sh` hook. With `worktreeMode: "light"`, an optional
`.lance-nuit/worktree-setup-light.sh` is preferred; otherwise the full setup hook
is used. Docker readiness is a separate opt-in `stackPreflight` configuration.

The worktree root defaults to `~/.lance-nuit/worktrees/<project>/<ticket>` and is
configurable with `WORKTREES_ROOT`.

## Lockfiles

`bun.lock` is the only repository lockfile. Use `bun install` when dependencies
change and commit the updated lockfile. CI and reproducible checkout installs use
`bun install --frozen-lockfile`.

npm remains responsible for packaging and consumer verification. The
`verify:production` check installs tarballs with `npm install --no-package-lock`
in a temporary consumer, checks registry resolution, and imports an extension
under Node. It requires Node.js and npm locally as well as in CI, but no
repository `package-lock.json`.

## Creating a project pipeline

Pipelines import the public type injected by the runner:

```bash
lancenuit create release --command 'make release-check'
lancenuit typecheck
```

The generated file can use `pipeline`, `bashStep`, `llmStep`, `actionStep`,
`artifact`, and composition helpers. See [`guide/dsl.md`](dsl.md)
and the [generated DSL reference](../docs/DSL-API.md) for type details.

For model and backend policies, continue with [Agents, profiles, and backends](agents-profiles-backends.md).
For cost and timeout limits, see [Budgets and timeouts](budgets-timeouts.md).
