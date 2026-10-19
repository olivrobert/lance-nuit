# Architecture

This guide explains how a run moves through the standalone runner. The code is
organized around the same boundaries: boot, dispatch, steps, backends, and state.

## 1. The execution layers

```text
pipeline <verb> <ticket>
        |
        v
runner.ts
  parse CLI -> commands -> boot -> load definition -> dispatch decision
        |
        +--> dispatch strategy
        |      scan a work-item source, spawn one child run per item, aggregate
        |
        v
step loop
  admission -> environment guard -> attempt -> verdict -> failure policy
        |
        +--> bash runner       shell command
        +--> agent registry    Claude, Codex, or another registered backend
        +--> function runner   in-process TypeScript action
        +--> pipeline runner   nested pipeline
        |
        v
state.json + events.jsonl + attempt logs + run history
        |
        v
console report, resumable outcome, token and cost projection
```

The wrapper is intentionally thin. Run commands select a pipeline name, while
diagnostic verbs map to runner flags; `runner.ts` owns ordering, persistence,
supervision, and reporting.

Bun is the runtime end to end. `bin/lancenuit` starts `runner.ts` with the `bun`
it found on the `PATH`, which loads the TypeScript entry point with no
transpilation loader, and every process the runner relaunches — a child run, the
live-feed formatter — reuses `process.execPath`. The runtime therefore never has
to be carried down through the environment. Node.js runs development tools and
npm consumer verification; see [CONTRIBUTING.md](../CONTRIBUTING.md).

## 2. Repository layout

The application has one public extension boundary:

```text
lance-nuit/contracts       stable ports and registries
          ^
          |
lance-nuit      one application under src/
  ├── runner engine
  ├── DSL
  └── built-in integrations
```

Internal integrations depend on core contracts, but they are not separately
published packages. See [core contract and extensions](packages-and-extensions.md)
for third-party adapters.

Everything under `src/` belongs to exactly one of seven levels. A folder belongs
to a single level, a file is never classified apart from its folder, and a level
may only import from its own level or below. Inside a level, imports are free;
cycles are forbidden at every level.

| Level | Folders | May import |
| --- | --- | --- |
| L0 `lib` | `src/lib/` — runner utilities | `node:` built-ins only |
| L1 `contracts` | `src/contracts/` — public extension contracts only | L0. Types and pure functions; no `node:fs`, no `process.*`, no `zod` |
| L2 `model` | `src/model/` — data shapes and ports | up to L1, no I/O |
| L3 `infra` | `src/env/` (config, paths, locks, worktrees, capabilities), `src/exec/` (process execution and supervision), `src/runtime/` (context, logging, events, the abort scope, and the `RunOutput` and `LiveFeed` ports) | up to L2 |
| L4 `core` | `src/validation/`, `src/pipeline/` (context assembly and definition loading), `src/dsl/` and `src/dsl.ts` (authoring primitives, internal authoring surface), `src/builtin-steps/`, `src/extractors/`, `src/engine/` (backend registry and built-in agent integrations), `src/step/` (attempts, retries, fixes, escalation), `src/dispatch/`, `src/boot/`, `src/run-record/` (the run record: snapshot, journal, attempt logs, transitions, cost ledger and budget), `src/work-item-store/` (artifacts, human decisions and provenance kept beside a ticket), `src/run-stats/` (the cross-run history: one summary per finished run, and its readers), `src/project/` (public DSL and project typechecking), `src/builtins/` | up to L3 |
| L5 `adapters` | `src/output/` (console reports, live feed, watchers), `src/modules/` (domain modules such as the Jira adapter), `src/commands/` | up to L4 |
| L6 `entry` | `src/entry/` (composition root), `src/cli/` (argument parsing), `src/runner.ts` — process entry point | everything |

`bun run deps:check` is the authority, not this table: it validates
`.dependency-cruiser.cjs` against the tree, proves that every file under `src/`
is claimed by exactly one level, and compares the remaining violations to
`.dependency-cruiser-known-violations.json`. That file is not a debt record any
more; it holds only edges someone argued for, each with a `why` and a review
date. A new upward import or a new cycle fails the lint; a listed edge that no
longer exists fails it too.

The same check also groups the graph by folder — one node per folder directly
under `src/`, plus one per file directly under `src/`, so `src/dsl.ts` and
`src/dsl/` stay apart — and reports every edge caught in a cycle of that grouped
graph. Two folders lock each other as soon as one file of each imports a file of
the other, which the file-level `no-circular` rule never sees. Those edges are
listed in `.dependency-cruiser-known-folder-cycles.json`, under the same rules as
the file baseline plus a `removedBy` naming the cut meant to retire the entry.
That baseline is now empty: `src/` holds no folder cycle at all, and
`bun run deps:check` defends the state by failing on the first cyclic folder
edge it finds.

### Modules

Levels say which way an import may go. Modules add a second, independent axis:
encapsulation, that is, through which file an import may enter. A module is a
folder with a single entry file; from outside the folder, only that entry may be
imported, while the files inside import each other freely. A module still sits
in exactly one level, and the level rules apply to it unchanged.

| Module | Entry |
| --- | --- |
| `src/modules/ui/` | `index.ts` |
| `src/modules/read-model/` | `index.ts` |
| `src/modules/dashboard-home/` | `index.ts` |
| `src/modules/work-item/` | `registry.ts` |
| `src/extractors/` | `registry.ts` |
| `src/step/` | `step-loop.ts` |
| `src/engine/` | `default-registry.ts` |
| `src/work-item-store/` | `index.ts` |
| `src/run-stats/` | `index.ts` |
| `src/run-record/` | `index.ts` |

`scripts/layers.cjs` declares them in `MODULES`, next to the levels.
`.dependency-cruiser.cjs` turns each one into a `module-<name>-entry-only` rule,
and `bun run deps:check` also fails when a declared entry no longer exists.
Test files are not cruised, so a test may still reach a module's internals.

These rules have no baseline. A module is declared in the same change that routes
every outside import through its entry, so a deep import is never recorded as
debt: it is fixed, or the module is not declared yet. `deps:check` enforces it: it
refuses a baseline entry naming a `module-<name>-entry-only` rule, and
`--write-baseline` refuses to run while such a violation remains. Narrowing what an entry
exports is then enough to make the corresponding use impossible outside the
module, without any further rule.

### The composition root

`src/entry/` composes the registries for normal runs. `src/commands/registries.ts`
is a second composition root for commands that run outside a pipeline, such as
approval-only, lint, and diagnostic commands. Both paths call the default
registry factories and pass the resulting registries down. Nothing in the
execution or state layers reaches back for a default registry or chooses a
built-in backend. Boot then extends the caller-provided registries with
manifest-declared providers before a run uses them:

- **registries** — `entry/registries.ts` composes providers for runs and
  `commands/registries.ts` does the same for out-of-run commands. The built-in
  provider lists live in `engine/default-registry.ts` and
  `modules/work-item/registry.ts`; boot extends the selected registries with an
  explicit manifest, and everything downstream reads them from the pipeline
  context (`agentBackendRegistryOf`, `workItemRegistryOf`). A context without a
  registry fails loudly at the first agent step rather than falling back.
- **`RunOutput`** — the interface and the composite live in `src/runtime/`, the
  console and live-feed implementations in `src/output/`. The step loop takes one
  as a required argument; it never picks a default. Step progress travels on it,
  and so do the execution messages of the sites that hold one, as `runner.message`
  events carrying their severity as a field. A site with no `RunOutput` in scope —
  boot and dispatch, but also a few helpers reached from inside a run, such as the
  attempt lifecycle in `step-attempt.ts` — writes to stderr instead and therefore
  never reaches the live feed (see [sessions and tracing](sessions-tracing.md)).
- **`LiveFeed`** — same split: the port and `setRunnerLiveFeed` in `src/runtime/`,
  `FileLiveFeed` and its construction from the environment in `src/output/`. The
  event bus writes to the feed it was given, so a child process inherits the
  parent's feed because the entry point wired it, not because the bus looked it up.
- **Abort scope** — `createAbortScope()` in `src/runtime/abort.ts` holds the
  interruption state of one execution tree: whether a signal was received, which
  one, and the runs currently executing steps. `runner.ts` creates one per
  process; the signal handler (`entry/signals.ts`) requests the abort on it and
  persists every active run; the step loop registers each run it executes and
  reads the scope before every spawn, as do the rerun and repair loops; a
  composed child runs under its parent's scope, which is how the interruption
  reaches an in-process child run that never receives `run.aborted`. There is no
  process-wide flag: two scopes never observe each other, so a test can drive an
  interruption in-process.

The event bus (`runtime/events.ts`) and the configured live feed stay process-wide
on purpose: an in-process child run must write to the same feed as its parent,
and every process has exactly one. Tests reset them (`resetRunnerEventBus`,
`setRunnerLiveFeed(undefined)`) rather than scope them.

Outside `src/`:

```text
examples/builtin-reviews/ executable review-step reference
bin/lancenuit   verb-oriented wrapper
```

### The dashboard

`src/modules/ui/` is the only part of the repository that ships code for a
browser, so it is the only one with a build of its own. Its server side runs
against explicit ports and never reads `env` past its composition root:

```text
src/modules/dashboard-home/  the files under ~/.lance-nuit/ui/, one owner each:
                             FileUserList, FileProjectList, FileLaunchStore
                             (openDashboardHome binds the three to one home)
src/modules/read-model/      every dashboard read, bound once as the ReadModel port
src/modules/ui/              server side
  server.ts                  composition root: builds UiDeps, starts node:http
  deps.ts                    UiDeps — readModel, home, launcher, terminals, workItems
  router.ts                  host, method and same-origin checks, then the ROUTES table
  routes/                    one module per /api resource; `open` or `operator` access
  http/                      respond, body, guards, identity: the HTTP helpers
  verbs.ts                   which verbs an item admits, and their exact argv
  launcher.ts                VerbLauncher: spawns the runner detached, records the launch
  tmux.ts, terminals.ts,
  terminal-viewers.ts        the embedded terminals
  static-files.ts, markdown.ts, cookies.ts
src/modules/ui/app/          React 19 + TypeScript sources of the front end
  index.tsx                  entry point: QueryClientProvider + RouterProvider into #app
  router.tsx                 TanStack Router route tree on the hash; search params
                             validated by pure functions of lib/
  App.tsx                    root gate (unreachable server, identity page), the
                             stats and terminal pages, the route error screen
  api/                       client.ts, the only HTTP code (reads throw ApiError,
                             writes resolve an ApiResult union); queries.ts, the
                             TanStack Query keys, options and poll; mutations.ts,
                             every write and its toast; types.ts, type-only
                             re-exports of the server's DTOs
  store/ui-store.ts          zustand: client-only state (search, replies, open
                             folders, toast, last inbox address); no server data
  hooks/                     keyboard, attention notifications, debounce
  lib/                       pure derivation and formatting, one module per screen
                             concern (items, inbox, sheet, run-timeline, report...),
                             unit-tested
  components/                one folder or file per zone of the screen
  styles/tokens.css          the only global stylesheet; everything else is a CSS Module
src/modules/ui/static/       index.html, plus the built app.js and app.css
```

The server is authoritative for actions. Each item it serves carries `busy`
and `verbs`, the offers `verbsFor` computes from the same admission rules and
the same argv builder that `POST /api/actions` applies; the front end renders
those offers and holds no copy of the rules. A route reaches the filesystem
only through `home` or `readModel` and a process only through `launcher` or
`terminals`: `UiDeps` is the whole seam between a route and the machine.
The front end imports server types only as `import type`: nothing from the
server side enters the bundle.

The server side reads work items only through `src/modules/read-model/`
(`index.ts` is its public surface, and the only module allowed to import
`src/run-record/`, `src/work-item-store/` and `src/run-stats/`; a Semgrep rule enforces the
direction). It projects snapshots into the DTO the front end renders. It takes
the work-item paths from `workItemLayout` and a stopped gate's decision from
`gateDecisionStatus`, both in `work-item-store`, the rule the runner's gate and
`--inspect` read too. The selected run's status is the run record's
`effectiveStatus`, asked with the runner's `runLockHolder`: a snapshot without a
verdict that no live process holds is served as an interrupted `ABORTED` run, so
the dashboard and a later resume agree on what is live. Its step list is the snapshot reconciled with the
journal by `projectRunState`, the projection a resume applies. Two of its readers take
content a pipeline wrote rather than runner state: `Item.title`, the first
`# ` heading of `artifacts/ticket.md` (a leading ticket key dropped), read
from a bounded prefix of the file and absent when there is none, and `readReport`, which validates
`artifacts/report.json` field by field against the current run
([delivery report](work-item-layout.md#delivery-report-artifactsreportjson)).
Both read the effective work-item directory, so a worktree run shows its
worktree copy, and neither calls the work-item provider. `readStats`
(`stats.ts`) serves the ticket-costs screen: it walks every root run of every
listed project on request, never from the poll, and merges the external
archive described in [usage](usage.md#ticket-costs).

In the front end, the address is the source of truth for where the reader is —
chip, item, sheet tab and file, stats filters (`lib/inbox-address.ts`,
`lib/stats-search.ts`) — the query cache for what the server said, and the
zustand store only for what neither owns. No state is copied from one to
another; `InboxScreen` is the one place that writes a corrected inbox address
back.

`bun run ui:build` bundles `app/index.tsx` with esbuild into
`static/app.js` and `static/app.css`, which the static handler serves verbatim.
Those two files are build products: they are git-ignored, never edited, and
rebuilt by `bun run ui:dev` on every save. The bundle is self-contained — React
is inlined and no runtime dependency is added — so packaging checks are
unaffected. `scripts/build.mjs` runs the front-end build before copying
`static/` into `dist/`.

Every `*.module.css` is scoped to the component beside it; `styles/tokens.css`
holds what cannot be scoped without losing its meaning: the custom properties,
the element reset, and the few classes that describe a value rather than a
component (`.mute`, `.small`, `.tag`, `.proj`).

Top-level integration and public-surface tests are grouped under `tests/` by domain:
`tests/dsl/`, `tests/pipeline/`, `tests/project/`, and `tests/runner/`. Tests that are
tightly coupled to a lower-level module remain beside that module (for example under
`src/boot/`, `src/engine/`, or `src/run-record/`). The public DSL is exposed through generated project
declarations rather than by making every internal runner type public.

## 3. How a pipeline is assembled

A pipeline is a TypeScript definition. At load time, the runner combines it with
configuration, prompts, capabilities, and extractors:

```text
pipeline definition (.ts)       project config
  order, roles, orchestration      profiles, step overrides, budgets
           |                                  |
           +--------------+-------------------+
                          v
                 pipeline loader
              import -> normalize -> validate

promptTemplate() / promptFile() ------------> command
extractor + report file --------------------> fix context
```

Review entries are ordinary steps. The
[`examples/builtin-reviews`](../examples/builtin-reviews/README.md) example shows
a complete set; a project should copy only the checks it actually needs and
express project-specific commands directly in TypeScript. `when` is an admission/precondition, `require` is an environment
guard, `report` and `errorExtractor` describe machine output, and `onFail`
declares retries or repair explicitly.

## 4. Boot order

The order of the boot registry is part of the runner contract:

```text
parseRunnerArgs()
  |
  +--> commands (--help, --typecheck, --inspect, --logs, --clean, ...)
  |       commands exit without taking a run lock
  |
  +--> validate dispatch arguments
  |
  +--> BOOT[]
          worktree       optional git worktree and cwd switch
          pipeline path  explicit path or builtin lookup
          config         project/user configuration loading
          context        cwd, ticket, paths, stores, and runner directory
          lock           stale-safe lock for the current project cwd
          stack          optional Docker readiness preflight
          worktree-ready optional project hook once the stack is ready
  |
  +--> loadPipelineDefinition() once
  +--> selectDispatch()
  +--> clean-tree guard for a fresh top-level run
  +--> loadOrCreateRun()
  +--> live feed and step loop
```

A child runner inherits the parent context and uses `RUNNER_DISABLE_DISPATCH` to
avoid recursively selecting the same dispatch strategy. The parent coordinates; the
child executes the actual steps.

Only the dispatch children the runner spawns itself inherit its internal state:
`RUNNER_LOCK_HELD`, `RUNNER_IN_WORKTREE`, `RUNNER_EVENTS_FILE`/`RUNNER_LIVE_FEED`
and `RUNNER_DISABLE_DISPATCH`. Bash steps, admission commands and agent backends
get the environment without them (`RUNNER_BIN` and `RUNNER_DIR` stay), so a runner
started from a step takes the lock, applies the worktree guards and writes its own
journal.

## 5. The step lifecycle

```text
budget exceeded? ---- yes ----> run stops, remaining steps stay pending
       | no
       v
admission (`when`, freshness) ---- skip ----> skipped (a done step stays done)
       | pass
       v
environment guard (`require`) ---- fail -> hard failure, no agent spawn
       | pass
       v
attempt
  bash   -> exit status
  agent  -> provider result + structured verdict
  fn     -> action result
       |
       v
success? ---- yes ----> done
       | no
       v
error extractor -> fix context -> failure policy
       |
       +--> rerun
       +--> fresh fix session -> retry
       +--> resume an earlier step's session -> retry
       +--> one-shot fix
       +--> warning / stop / failed
```

An extractor enriches a fix prompt; it never changes the underlying command's exit
status. A verdict with `"blocked": true` reports an environment obstacle that code
cannot repair, so the runner stops cleanly instead of burning fix attempts. A
`BLOCKED:` prefix on a reason says the same thing in prose, and is read at two
boundaries only — the verdict parser and the normalization of a backend result. The
step loop reads the resulting `failCause` field and never prose. See
[failures, retries, escalation](failures-retries-escalation.md).

Every attempt has a durable identity and log. The event journal is the source for
timeline and statistics projections; the state snapshot is the fast resume surface.

### Who decides that a step runs

Whether a step runs on this invocation is decided in two places, in this order,
and each rule they read has one owner:

| Decision | Owner |
| --- | --- |
| **Re-admission**: whether a settled step goes through admission again, and, in reconcile mode, whether this invocation's `--steps`, `--skip` or `--start-at` leaves it out | `step/step-loop.ts` (`executeRunSteps`, `leftOutBySelection`). Boot (`boot/resume.ts`) applies the selectors to the snapshot in the default mode only; in both modes it requeues the `--start-at` target and the steps after it |
| **Admission**: budget, `when`, a pending rejection, the freshness or presence of the outputs, the interruption guard, then the environment guard | `step/step-admission.ts` (`admitStep`; `answersToOutputs` says whether the outputs decide, `skipForOperatorSelection` settles a step the selection left out, or keeps the status of one whose last pass is unfinished) |
| **Standing of an output**: `missing`, `unfinished`, `unknown`, `stale`, `fresh` or adoptable, and the doubt `unguaranteed` carries | `work-item-store/provenance.ts`, the only writer of `artifacts/.provenance/`. `standingOf` is the one reading rule for a record: admission (`stepFreshness`), the public `freshness()` and the dashboard all read it there. The attempt (`step/step-attempt.ts`) only chooses when to write: the in-flight mark before each attempt (`markInFlight`), the record after a success |
| **Reconcile classification**: which steps the mode re-admits (those declaring `output` or `rerunOnResume`), the build error for a step declaring neither, and the orchestration nodes that keep the authority of their status | `model/definition.ts` (`deliversOutputs`, `reconcilable`, `stepsWithoutDeliverable`), shared by the build (`.reconcile()`), the loader's validation (`validation/structure.ts`), admission and the loop; `rerunsOnResume`, which leaves a node's `rerunOnResume` without effect in this mode, is used by `reconcilable`, the loop and the resume header |

Two run facts beside the decision are runtime-only and never persisted
(`model/run.ts`): `Run.reconcile`, set by boot from the definition it loads the
steps from and read by the step loop, so boot and the loop cannot disagree on
the mode; and `Run.executingStepId`, written by `updateStep` alone and read by
`abortRun`, so that a signal interrupts the step this process is running and
never one a dead runner left `running`. What the run record still decides in
reconcile mode, and what the deliverables decide instead, is tabled in
[persistence](persistence.md#the-run-record-and-the-deliverables).

## 6. Capability lookup

The runner reads frontmatter from skills and agents because provider capabilities
can impose axes such as `model`, `effort`, or `context: fork`. The preflight and the
runtime lookup share the same suffix rules:

```text
qualified skill: plugin-name:review
  -> plugin-name/skills/review/SKILL.md

qualified agent: plugin-name:browser
  -> plugin-name/agents/browser.md
```

For a historical kit checkout, the runner recognizes
`<kit>/lance-nuit/runner` and probes `<kit>` first. For a standalone checkout,
it probes the runner root itself. Both layouts then fall back to:

1. `<project>/.claude`
2. `~/.claude`

Set `PIPELINE_CAPABILITY_ROOTS` when capabilities are installed outside those
locations. Explicit roots are searched first and use the platform path delimiter.

## 7. Persistence and observability

A run keeps operational state close to its work item:

```text
.lance-nuit/work-items/<ticket>/
├── artifacts/       business outputs declared by the pipeline
├── reports/         machine and human review reports
├── runs/<pipeline>/<run-id>/
│   ├── state.json
│   ├── events.jsonl
│   └── steps/<step>/attempt-001/output.log
└── decisions/       approval records when the pipeline declares them
```

Persisted formats (`state.json`, `events.jsonl`) and configuration files
(`config.json`) are read through runtime schemas (`run-record/schema.ts`,
`run-record/journal-schema.ts`, `env/config.schema.ts`). Two rules keep that boundary
honest:

- The types stay hand-written interfaces (`PersistedRun`, `PersistedStepState`,
  `PipelineConfig`). Schemas import the interfaces and prove their agreement at
  compile time; interfaces never import a schema, and no type reachable from the
  DSL is inferred from one. The installed DSL declarations must contain no
  reference to `zod` (`tests/project/declarations-no-zod.test.ts` guards it).
- The diagnostic policy is set per boundary: a malformed `config.json` stops the
  runner and names the file; a malformed `state.json` is treated as absent by
  discovery and reporting readers, with the reason available separately
  (`diagnoseRunSnapshot`), while execution refuses to select that run or fall
  back to a new one; a line
  of the central history (`pipeline-history/runs.jsonl`,
  `run-stats/history-schema.ts`) that fails its schema is skipped so one
  truncated write never costs the whole file (`diagnoseHistoryEntry`); a
  malformed `pricing.json` is reported once by name and treated as absent
  (`env/pricing.schema.ts`), because pricing is optional and statistics readers
  must keep working without it; **no line of the run journal (`events.jsonl`,
  `run-record/journal-schema.ts`) is ever discarded** — the file doubles as the live
  feed, so a reader classifies every line as `known`, `unknown` (a type outside
  the contract, which is most of a real journal), `invalid` (a contracted type
  whose payload was refused, kept with its reason) or `skipped` (not an event at
  all), and the four counters are reported per run by `--inspect`
  (`diagnoseRunJournal`). As in the history schema, an optional field of the
  wrong kind reads as absent rather than refusing the event: only the fields a
  reader needs to act on decide validity, because an event refused whole is an
  event absent from the resume projections.

The same two rules cover the formats the runner only reads. The NDJSON event
stream of each agent backend (`engine/backends/*/events.schema.ts`) and the
output of `docker compose ps` (`env/docker-stack.schema.ts`) come from tools the
runner does not version, so their schemas never reject: an unknown event type
falls through a fallback branch and is ignored, a field of the wrong kind reads
as absent, and an unreadable `docker compose ps` entry is skipped — a required
service missing from the result is then reported as absent by the preflight.

Writes use temporary files and rename operations where atomicity matters. A process
interruption therefore leaves either the previous valid snapshot or a complete new
one. Logs and events remain useful even when a provider is killed before its final
result event.

The console report is the human-facing projection. The run-stats projector derives
phase, model, profile, token, cost, and outcome facts without reading provider state.
Pricing is optional; exact provider-reported cost wins over token estimation.

The run record — snapshot, journal, attempt logs, transitions, cost ledger and
budget — is the `src/run-record/` module: code outside it imports
`run-record/index.ts` only, and the files named below are its internals.
Run and step transitions during execution have one owner, `run-record/run-transitions.ts`:
the step status with its timestamps and reason (`updateStep`), the verdict an
attempt established (`recordStepVerdict`), an absorbed non-blocking failure
(`absorbStepFailure`) and the inputs it settled at (`recordAbsorbedInputs`),
a clean stop (`stopRun`), a manual interruption
(`abortRun`), and the final verdict, outcome, totals and `run.finished` event
(`finalizeRun`). Each operation writes the fields that must change together and
the journal event that records them. What a status means has one owner too,
`run-record/run-status.ts`: the status a reader shows (`effectiveStatus`, with
the run lock as a parameter), what each status says (a verdict, completed, a
failure, waiting on somebody, resumable), the `≥` of a partial total
(`costIsLowerBound`, in `cost-accounting.ts`), and one precedence table,
`runEnding`, from which `finalizeRun` takes the status, the console report its
headline and the entry point its exit code. The dashboard, `--inspect`,
`lancenuit close`, `clean --keep-failed`, the statistics, the stack stop, the
signal handler and a composing parent all ask it instead of comparing statuses
(`tests/runner/run-status-readers.test.ts` refuses a copy). After an interruption only `finalizeRun`
still moves the run: it keeps `ABORTED` and completes the outcome, the totals
and the snapshot, while the other transitions change neither memory nor
snapshot. Attempt closure (`run-record/attempt-closure.ts`), cost figures
(`run-record/cost-accounting.ts`) and budget stops (`run-record/cost-stop-events.ts`) keep
their own owners. The persisted child reference of a composed run — the record a
`runPipeline` or `forEachPipeline` node keeps in the parent snapshot for each
child call — moves through `run-record/child-transitions.ts` only: declared
`pending`, committed and bound to a child run id, skipped, failed at launch, or
settled from the child's own verdict with the `pipeline.child.started` and
`pipeline.child.finished` events. The composition code
(`step/pipeline-orchestration*.ts`) orders the cycle of a child — gate, boot,
execution, reconciliation, settlement — and calls those operations, cost
accounting for the child's spend and `finalizeRun` for its verdict, without
restating their rules. Restoration
on resume (`boot/resume.ts`, `run-record/run-projection.ts`) rebuilds state and is
not a transition. Which of the snapshot and the journal is believed for each
concept, and what each crash window leaves behind, is tabled in
[persistence](persistence.md#which-record-is-authoritative). Presentation and
statistics read a `RunView` (`model/run.ts`), a read-only view of the run, and
never move it forward.

## 8. Profiles, backends, and the two escalations

An agent step has two explicit selectors: `backend` chooses the provider and
`profile` chooses its semantic role. The effective model/effort policy is resolved
from `profiles.<role>.backends.<backend>` (built-in policy plus project overrides).
The runner does not automatically fall back to another backend when a policy or
provider is unavailable. Provider-specific `options` configure technical behavior;
they do not define the nominal model or effort.

The runner has two independent escalation paths:

- **Capacity escalation** (`onFail.escalate`) retries a failed step with a higher
  effort rung and/or another model on the same selected backend. It consumes the
  step/run budget and remains part of the technical failure loop.
- **Human/work-item escalation** (`workItemEscalateStep` or
  `humanReview`) publishes a structured tracker note, moves the ticket to
  `escalate`, and may stop behind a human gate. It is a business transition, not a
  provider retry.

See [`failures-retries-escalation.md`](failures-retries-escalation.md) and
[`human-control.md`](human-control.md) for the authoring APIs.

## 9. Extension boundaries

| Need | Extension point |
|---|---|
| Add an execution provider | `AgentBackend` factory, listed under `backends` in an `ExtensionManifest` |
| Add a ticket system | `WorkItemGateway` adapter, listed under `workItems` in an `ExtensionManifest` |
| Add a project quality check | a `bashStep`, `llmStep`, or `actionStep` in the pipeline |
| Add a pipeline | `.lance-nuit/pipelines/<name>.ts` |
| Add a reusable fix parser | A runner-distributed `extractors/<name>.ts` module exporting `extract` |
| Prepare a run environment | a project worktree hook |

The runner stays small by keeping these concerns behind ports and registries. A new
project pipeline should normally use the injected DSL; it should not import internal
step-loop or persistence modules.
