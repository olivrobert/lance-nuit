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
npm are still required for development tools and package verification; see
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
