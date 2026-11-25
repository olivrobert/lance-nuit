# Persistence

The runner separates business data, human decisions, and run telemetry. A work
item normally looks like this:

```text
.lance-nuit/work-items/<ticket>/
├── artifacts/                 # durable business outputs (JSON, Markdown, inputs/…)
│   ├── ticket.md              # tracker snapshot used as pipeline input
│   ├── inputs/                # optional human-provided files
│   └── lock.json              # runner-owned freshness lock: one stamp per step
├── reports/                   # disposable machine/human reports
│   └── <LOT-ID>/              # isolated reports for a batch sub-run
├── decisions/                 # hash-locked approval and rejection records
└── runs/<pipeline>/
    ├── latest -> <run-id>     # authoritative resumable selector
    └── <run-id>/
        ├── state.json         # the execution record
        ├── events.jsonl       # append-only trace of the journal events
        ├── feed.jsonl         # live feed: runner output, bash output, raw backend stream
        └── steps/<step>/attempt-001/
            ├── output.log
            └── command.txt    # the rendered command or prompt the attempt was given
```

`ctx.paths.artifactsDir`, `ctx.paths.reportsDir`, and
`ctx.paths.decisionsDir` are the canonical paths. Steps and skills should use
these context paths rather than rebuilding paths from a ticket name.
A batch (`lot`) receives `reports/<LOT-ID>/`; other phases use the work-item's
flat `reports/` directory. Artifact descriptors read and write through
`ctx.artifacts`, which validates names and keeps the logical interface
independent of the filesystem.

`decisions/<subject>.json` holds the current human answer for one subject; an
approval replaces a rejection and the reverse. A rejection adds the reason the
rework step reads and the round it opened:

```json
{
  "schemaVersion": 1,
  "decision": "rejected",
  "subject": "plan",
  "artifact": "artifacts/plan.md",
  "artifactSha256": "<sha256>",
  "decidedAt": "2026-09-03T12:00:00.000Z",
  "decidedBy": "human",
  "reason": "split step 2",
  "round": 1
}
```

The file is shared by a parent run and its children and survives `--fresh`, so
the round bound holds across runs. See
[human-control.md](human-control.md#reject-and-rework).

A project pipeline can split a parent plan into lots without creating a dispatch
run for each lot. The generic resolver also supports explicit nested work-item
paths and the `PROJ-28-01 → PROJ-28/US-01` mapping when that directory layout is
present. Such a child has the same `artifacts/`, `reports/`, `decisions/`, and
`runs/` families.

## The run record and the deliverables

The run record, `state.json` in the run directory, is the run's ledger, with
`events.jsonl` as its trace: what each step did and how its last pass ended
(done, failed, aborted, interrupted), its attempts and retries, the agent
sessions it opened, and what it cost against the budget. The deliverables live
beside it, in the work item: the artifacts in `artifacts/` and the stamps that
vouch for them in `artifacts/lock.json`. They outlive the run, so a new run, `--fresh`
included, finds them as the last one left them. The code that owns the run
record is the `src/run/record/` module; the rest of the runner reaches it
through `run/record/index.ts` only.

The two answer different questions
([admission of settled steps](dsl.md#admission-of-settled-steps)):

| Question | Answered by |
| --- | --- |
| Does a settled step run again? | its stamp in the [freshness lock](#freshness-lock): it runs when it has none or when its inputs or outputs changed ([input freshness](dsl.md#input-freshness)); a `rerunOnResume` step always runs |
| Did the last pass of the step in this run finish? | the run record: the [interruption guard](dsl.md#interrupted-steps) reads it, and so does a `--steps`/`--skip` selection, which stops rather than leave out an unfinished pass |
| What was spent, and may the run spend more? | the run record |
| Does a `runPipeline` or `forEachPipeline` node, or the work-item source step, run again? | its status, even when the node declares `rerunOnResume` |

`when` and a pending [rejection](human-control.md#reject-and-rework) come
before these answers.

`state.json` does not decide what remains to do for a step that declares
`input` or `output`, orchestration nodes aside: they keep the authority of their
status. It still holds everything only the run can know: spend, attempts,
sessions and the way a pass ended. A pass that did not settle `done` left no
stamp, so its step runs again whatever the status of the step in any run.

## Freshness lock

`artifacts/lock.json` is the runner's freshness lock: one stamp per step that
last settled `done`, binding the hashes of the inputs it declares to the hashes
of the outputs it declares. There is one per work item, shared by every run and
every pipeline of that work item. `work-items/store/step-lock.ts` is its only
reader and writer. Which steps are stamped, and how admission reads a stamp, is
described in [input freshness](dsl.md#input-freshness). A run without a ticket
has no work item, so no lock: its steps are never stamped and always run.

```json
{
  "schemaVersion": 1,
  "steps": {
    "plan": {
      "pipeline": "ticket",
      "runId": "20260903T115900.000Z-ticket-a1b2c3",
      "stampedAt": "2026-09-03T12:10:00.000Z",
      "inputs": { "artifacts/triage.json": "<sha256>", "source:tree": "<sha256>" },
      "outputs": { "artifacts/plan.json": "<sha256>", "artifacts/audit.json": "<sha256>" }
    },
    "quality-check": {
      "pipeline": "ticket",
      "runId": "20260903T115900.000Z-ticket-a1b2c3",
      "stampedAt": "2026-09-03T12:20:00.000Z",
      "inputs": { "artifacts/summary.json": "<sha256>" },
      "outputs": {},
      "absorbed": true
    }
  }
}
```

- **Key.** The step id. When the run carries a lot, the key is
  `<lot-id>/<step-id>`: lots share the artifacts of their work item. Two
  pipelines of one work item that use the same step id share its stamp.
- **`inputs`.** Every declared input and nothing else: an artifact under
  `artifacts/<name>`, with the SHA-256 of its bytes, or `null` when it is
  absent; a source under `source:<name>`, with the SHA-256 of its stdout, or
  `null` when its command failed.
- **`outputs`.** Every declared output, captures and the review capture
  included, under `artifacts/<name>`; never `null`, since the step's `require`
  already passed. The hash is the one a human decision records as
  `artifactSha256`, so an approval and a stamp agree on the same bytes.
- **`pipeline`, `runId`, `stampedAt`, `absorbed`.** Attribution and
  diagnostics only: no admission rule reads them. `absorbed` marks a
  `blocking: false` pass that absorbed its failure.

The pass of a step (`execution/step/step-pass.ts`) is the only place that
changes a stamp:

- it deletes the stamp before the first spawn of every pass; if that fails, the
  step fails before any spawn;
- it writes the stamp only once the pass settled `done`, and after that `done`
  is saved in `state.json`. A runner that dies between the two leaves a `done`
  step without a stamp, which only makes it run again; a stamp that cannot be
  written is reported as a warning, with the same effect;
- a pass that failed, was aborted, was interrupted or stopped writes nothing,
  and neither does an admission refusal or an `up to date` skip;
- a `blocking: false` pass that absorbed its failure is stamped with
  `absorbed: true` and `"outputs": {}` only when the step declares no output;
  with outputs, it gets no stamp.

Every write is one synchronous critical section under `artifacts/lock.json.lock`
(pid, nonce and stale reclaim, as the run lock): read the file, apply one
deletion or one stamp, write it atomically, release. Nothing awaits inside it,
so two writers of one process (a parallel group, a parent and its child) never
interleave, and a reader sees the old file or the new one. A lock held by
another live process is retried every 25 ms for at most 10 s, then the write
fails. Two live runs on one work item, `--worktree` runs for example, are not
supported: they clear and stamp each other's steps. The names `lock.json` and
`lock.json.*` are reserved: an artifact descriptor cannot claim them.

An absent `lock.json` reads as empty. An unreadable one (invalid JSON, another
`schemaVersion`) fails closed: admission fails the step and names the path, to
fix or delete. A step whose stamp cannot be cleared before its pass fails too.
Neither is absorbed by `blocking: false`: the lock is the runner's state, not
the step's verdict. Deleting it makes every stamped step of the work item run once.

The lock replaced the per-output records of `artifacts/.provenance/`, which the
runner now ignores and which can be deleted. Upgrading therefore runs every
stamped step of a work item in flight once: finish or close the work items
awaiting a gate before upgrading.

## Run snapshots and resume

`state.json` is the execution record, written as schema version 2 by one
writer (`run/record/run-repository.ts`): step status, retries, sessions,
profile attribution, usage/cost control data, every attempt of each step
(`attempts`: number, kind, status, session, log path and its own figures), the
child references of a composed node, and the run-level verdict, totals, and
cost decisions. The next attempt number is the highest `attempts[].attempt`
plus one, so a number, and its log directory, is never reused. Each attempt
copies the command it was given to `command.txt` beside its log, once, when it
starts; that copy is diagnostic, read only by the dashboard, and an attempt
whose copy cannot be written still runs. The pipeline definition and
configuration are reloaded when a run resumes, while persisted step state
(including the profile and session) is retained for correct attribution.

The reader accepts schema version 2 only, validates the full structure, and
fails closed on any other version. A run written by an earlier release (schema
version 1, whose attempts lived in the journal) is no longer readable: readers
treat it as absent, and execution refuses to resume it. Finish it with the
release that started it, or start a new run with `--fresh`.

The run record opens the run (`openRun`, `run/record/run-opening.ts`): it
selects the directory, reads the snapshot, and assembles the in-memory run from
the definition and the persisted steps, or creates a new run; it never reads the
journal. Every snapshot write and journal event of the opening is its own, and
it tells its caller whether it resumed.
`execution/step/load-or-create-run.ts` supplies the policy: it loads the definition — again, for a
resume, under the snapshot's spec path and lot — and validates `--start-at`
(`checkForkSource`): the source run, its pre-check and the refusals all come
before anything is written. `--start-at X` forks: `openRun` calls `forkRun`
(`run/record/run-opening.ts`), which creates a new run directory with the steps
before `X` copied as settled (no attempts, spend or errors, quotas reset) and
`X` and every later step blank `pending`, repoints `latest`, and closes the
source `SUPERSEDED` when it did not pass, with its unfinished composed child
runs. Journal: `run.forked` in the fork, `run.superseded` in each superseded
run.

The `--steps`/`--skip` selectors last one invocation, so the snapshot never holds an exclusion: boot excludes
nothing, and an `excluded` mark an older runner left is ignored. The step loop
applies them instead (`execution/step/step-loop.ts`): a
step they leave out is journaled as `step.skipped` with the reason
`operator selection`, and the run outcome carries the ids, which the final
report counts. A `done` step stays `done` and a pending one becomes `skipped`,
so the run can settle and pass; the next invocation re-admits them like any
other step, except orchestration nodes and the work-item source step, which
keep the status the selection left them: `done`, or `skipped` for one that was
pending.

A step whose last pass failed, was aborted or was interrupted keeps its status
when it is left out: the interruption guard and the rerun a failed pass is owed
are run facts the next admission reads from it. The run then stops with
`needs-decision` rather than pass into a new run that would lose them, unless an
`--until` bound or another stop ended it first (a run holding an aborted step
stays `ABORTED`). The outcome names the step that ended the invocation, never a
failed one the selection set aside. That pass left no stamp in any case, so
its outputs never settle the step (see
[the run record and the deliverables](#the-run-record-and-the-deliverables)).

A step a dead runner left `running`, an orchestration node killed mid-child
included, stays so while later steps run. The snapshot cannot tell it from the
step being executed, so `updateStep` records the steps this process put in
`running` (`Run.executing`, runtime-only), and a SIGINT or SIGTERM aborts those
only. A signal that lands while no step executes
(during an admission, or before the first step) marks no step `aborted`.

The readers (`readRun`, `run/record/run-read.ts`) — the dashboard, `--inspect`,
`close`, `--run` — see the snapshot as written, statuses and attempts included:
each transition is saved before it is journaled, so there is nothing to
reconcile.

Readers validate a snapshot against a runtime schema (`run/record/schema.ts`) that
mirrors the `PersistedRun` interfaces. Unknown fields are kept, so a snapshot
written by a later release stays readable, and fields an early release could
omit (`retries`) are normalized on read. Discovery and reporting remain
tolerant: a missing, corrupt, or incompatible file is reported as absent by
`readRunSnapshot`, while `diagnoseRunSnapshot` names the reason for tools that
want to display it. That tolerance does not authorize execution to create a new
run when `latest` points at damaged state; the run selector fails and leaves the
selector and old files unchanged. Inspect the named path and restore it, or use
`--fresh` deliberately to create a separate run.

A snapshot also records where and why the run stands where it does:

- A fork records `forkedFrom` (the source runId), `startAt` (the step it forked
  at) and `inheritedSpendUsd` (the source's inherited spend plus its own,
  crashed attempts settled first). The ledger seeds with the inherited spend
  plus the run's own and compares the sum to `max_cost_usd`; `total_control`,
  the report and the statistics count the run's own spend only. A run closed by
  a fork has the status `SUPERSEDED` and `supersededBy` (the fork's runId): a
  verdict like `PASS`, never written again, not resumable, not a failure and not
  awaiting a human. While `startAt` has never left `pending` in the fork, that
  step is forced to run even when fresh in the lock, and only `rerunOnResume`
  steps are admitted before it.

- `worktree` and `cwd` say where the run executed — `cwd` is the effective
  working directory after the worktree `chdir`, which is the tree whose
  `artifacts/` and `decisions/` the run reads and writes. A resume from another
  place rewrites both.
- `outcome.stop` describes a clean stop without making a reader parse
  `stopped_reason`: `detail` is the reason without the console decoration,
  `kind` is the expected recovery (`needs-info`, `needs-decision`, `needs-human`,
  `blocked` for a step whose `fail_cause` says so, or `until` for the bound an
  operator set with `--until`, which a plain rerun lifts), `subject` is the
  approval subject that lifts the stop when the gate declares one, and
  `artifact` (`artifacts/<name>`) is the artifact a `humanReview` gate is
  about — the file the dashboard opens under the decision, since only the
  runner knows which artifact a subject is bound to. The same object is
  attached to the `run.stopped` journal event.
- `steps[].fail_cause` and `outcome.failCause` name a failure no fix pass could
  have cleared. The only value is `blocked`: an obstacle outside the code, which
  an agent declares with `"blocked": true` in its verdict (see
  [failures, retries, escalation](failures-retries-escalation.md)). Same life
  cycle as `fail_kind` — written on failure, cleared on success and by the next
  attempt — and orthogonal to it: the kind says whether the attempt broke or was
  judged, the cause says repairing is pointless. Optional and additive, so
  the schema is unchanged and a snapshot written without it reads as "no such
  cause". `step.status.changed` carries the same field in the journal.
- `outcome.stopKind` names the cost policy that ended the run:
  `budget-exceeded` when the ceiling stopped it, `cost-unaccounted` when a gate
  withheld work over spend nobody could price. It is absent for every other
  outcome, including a run whose total is a lower bound but which failed for its
  own reason. It is the only durable machine-readable answer for a budget stop:
  `budget_exceeded` is deliberately wiped by the `--budget` resume that answers
  it, and the step the guard killed keeps `fail_kind: "technical"` because that
  field drives retry policy at step level and must not carry a run-level
  decision. `run.finished` inherits the field with the rest of the outcome, and
  the journal records the same stop as `run.budget.exceeded` /
  `run.cost.unaccounted` (see [sessions and tracing](sessions-tracing.md)). Every
  finalization rewrites the outcome, so the kind always describes the generation
  that wrote it.

- `cost_unaccounted` latches run-level uncertainty: at least one attempt of this
  run, or of a composed child folded into it, spent tokens no pricing table could
  price. Nothing clears it — no resume, no later priced attempt, no `--budget` —
  because nothing can retroactively price a closed attempt. A capped run carrying
  it stops with `cost-unaccounted` unless it is authorized. It is the attempts'
  own `cost_unknown` made durable: the ledger reads the same fact from the
  attempts, and writes the latch when only they carry it.
- `allow_unmetered` records that a human authorized that unknown spend with
  `--allow-unmetered`. It lifts the accounting stop only: `max_cost_usd` still
  governs what the runner could price. Absent means strict — a missing
  authorization is never read as permissive. It is propagated to the children
  launched in the run's budget scope, and a composed child cannot set it for
  itself while an ancestor's ceiling governs it.

All of these are optional: a stop raised by an admission that describes nothing
carries `stopped_reason` alone.

Each attempt gets its own log; resuming never truncates `events.jsonl` or
`feed.jsonl`. The
`latest` symlink is reused only when its snapshot is resumable (`pending`,
`running`, `failed`, or `aborted` work remains). A completed (`PASS`) run is not
resumed; a run interrupted by SIGINT, stopped cleanly at a gate, or stopped by its
budget is, since each keeps the work it had left to do. A run whose steps are all
settled but that never received a verdict — a crash or a Ctrl+C in the window
between the last step snapshot and finalization — is also resumed, so the next
invocation stamps its verdict instead of replaying the whole pipeline. Use
`--fresh` to force a new timestamped run, or `--run <runId>` to select an
existing run explicitly for inspection, logs, or resume.

A `PASS` run is never written again: it is opened read-only, and `saveRun`
refuses to write it. `--run <runId>` that would execute it fails and points to
`--start-at <step>`, which forks a new run from it; a `SUPERSEDED` run is
never written again either, and `--run` on it fails the same way; a parent that
re-enters a `PASS` child opens it read-only and settles its reference from the
child's snapshot.

A run directory is held by a single writer: `runner.lock` records the owning pid,
and a dead holder is reclaimed automatically. Reclaiming a stale lock goes through
the same protocol as the project-wide runner lock, so two runners that find the
same dead holder cannot both take the directory. `--run <runId>` fails when another
live runner holds the target, and so does an implicit resume of a resumable
`latest`: it exits 1 with the holder pid and the options — wait and rerun, select
another run with `--run <runId>`, or start a new one with `--fresh` — rather than
silently start over and replay work already done and paid for.

A composed child takes no lock of its own: it runs inside the process of the run
that composed it, which hands it its directory. Its holder is that run's, up to
the root, unless the child was resumed directly with `--run`, which takes its
lock. A reader that asks whether a run is live (`--inspect`, `close`, the
dashboard) follows `parentRunId` up the composition for that reason
(`isRunHeld`).

Two details of that lock file are worth knowing when reading one by hand:

- Next to the pid, the payload carries a `lockNonce` field: a random value
  generated once per process. Ownership is the pid *and* that nonce, so a lock is
  released only by the process that published it — an operating system reassigning
  a dead runner's pid to a new one cannot make the new process look like the
  holder, nor let it free a lock it never took. The field is written by the lock
  itself; nothing else reads it.
- The payload also carries a `pidStart` field: a token identifying when the
  holder process started (boot id and start time on Linux, `ps -o lstart`
  elsewhere). A pid that is alive but whose current start token differs is a
  recycled pid — the runner died and the operating system gave its pid to an
  unrelated process — so the lock is stale and reclaimed. A lock without that
  field, written by an older build, keeps the pid-only check, and so does a pid
  whose start token cannot be read.
- A refusal means the holder is alive. A lock whose holder is dead, whose payload
  is corrupt, or whose pid is not a usable one is reclaimed without asking, so
  there is no reason to delete a lock file by hand — doing it while its runner
  works puts two runners on the same git tree. A lock path that exists but is not
  a readable regular file (a directory, a dangling symlink) is reported as an
  error instead of being treated as a free lock.

The snapshot is written through a temporary file and rename, so an interruption
leaves either the previous valid snapshot or a complete replacement. The event
journal and attempt logs remain useful even if an agent process dies before its
final result event.

If a normal invocation reports that the selected snapshot is unreadable or
incompatible, it stops before taking a step. This protects shell commands and
agent work from replay after a damaged write. `--run <run-id>` reports the same
problem for an explicitly selected run; on this failure it does not repoint
`latest`. After inspecting or restoring the old files, use `--fresh` when a new run is the
intentional recovery action.

### Attempt closure

An attempt is closed exactly once, whichever path ends it: a normal completion in
the step loop, a SIGINT/SIGTERM caught by the signal handler, or a hard crash
detected when the run is opened. The three paths go through the same writer
(`closeAttempt`, `run/record/attempt-closure.ts`), which sets the attempt status
and `finished_at`, normalizes its control data and charges it (see
[Where spend is written](budgets-timeouts.md#where-spend-is-written)); each
caller then saves the snapshot and appends one `step.attempt.finished` event
(`journalAttemptClosed`). A second closer finds the attempt no longer
`running` and does nothing, so an interruption that races with a completing
attempt never charges it twice or records two endings.

The same normalization applies everywhere: an agent attempt (a step with a
backend, or any fix pass) that fails or is aborted without a token count or a
price is marked `cost_unknown` and `cost_estimated`, so the budget ledger and the
report treat the total as a lower bound instead of reading the attempt as free.
An attempt that completes with `done` keeps whatever the backend reported, even
when that is nothing: the rule covers spend lost to a timeout, a signal, or a
broken transport, not a backend that does not meter.

The `step.attempt.finished` payload has one shape for every path:

| Field | Presence | Content |
| --- | --- | --- |
| `stepId`, `attempt`, `kind` | always | step, attempt number, and `step`, `fix` or `review` |
| `status` | always | `done`, `failed`, or `aborted` |
| `control` | always | normalized control data, including `cost_unknown` / `cost_estimated` |
| `logPath` | always | attempt log, run-relative |
| `sessionId`, `session` | when the backend reported one | session reference and the full session object |
| `provider`, `model` | when known | from the control data, or the session for the provider |
| `costUsd` | when priced | `control.total_cost_usd`; an abort carries its live estimate |
| `usage` | when measured | token counts |
| `reason` | on failure or abort | error text, or the abort reason |

Readers should not infer the ending from which fields are present (an aborted
attempt carries `costUsd` and `usage` when it has them); `status` and `reason`
are the discriminators.

### Which record is authoritative

`state.json` is the execution record: statuses, attempts and their numbering,
sessions, spend, child references and the verdict are read from it alone.
`events.jsonl` is a trace that no execution logic reads.

### Interruption windows

Every transition changes the run in memory, writes the snapshot through a
temporary file and rename, then appends its journal event. A crash therefore
leaves neither written, the snapshot alone, or both; the snapshot alone loses
only the trace event, never a fact a resume needs. A crash **before** the save
leaves nothing of the transition, and the resume replays it. One side effect can
survive: an attempt's log directory is allocated before its save, so an orphan
`attempt-NNN/` may be reused by the replayed attempt.

| Transition | Order |
| --- | --- |
| Run creation (`openRun`) | snapshot → `run.started` (→ `run.unmetered.authorized`) |
| Fork (`forkRun`) | the fork's snapshot → `latest` → the source's snapshot (`SUPERSEDED`, crashed attempts settled) → `run.superseded` in the source, then in each unfinished composed child → `run.forked` in the fork |
| Run opening on resume (`openRun`) | one snapshot (location, a new authorization, crashed attempts settled, status back to `RUNNING`) → `run.resumed` (carries `{ pipeline, steps, skip, until }`, null when absent) when the run goes on → the settled attempts' `step.attempt.finished` → `run.unmetered.authorized` |
| Attempt start (`openAttempt`) | the attempt `running` in the snapshot, before the spawn → `step.attempt.started` |
| Attempt end (`settleAttempt`) | closure, verdict and ledger charge in memory → snapshot → `step.attempt.finished` → live-guard stops → `step.cost.unaccounted` |
| Step status (`updateStep`) | snapshot → `step.status.changed` |
| Clean stop, interruption, verdict (`stopRun`, `abortRun`, `finalizeRun`) | snapshot → `run.stopped`, `run.aborted` or `run.finished` |
| Composed child launch (`bindChildRun`, `recordChildStarted`) | parent snapshot (reference bound to its `runId`) → child snapshot → parent snapshot (reference `startedAt`) → `pipeline.child.started` |
| Composed child settlement (`chargeChildReconciliation`, `settleChild`) | parent snapshot (`accounted*` figures) → `pipeline.child.cost.reconciled` → parent snapshot (reference settled) → `pipeline.child.finished` |

What a crash leaves is resolved from the snapshot alone:

- An attempt still `running` when the run is opened with no live holder belonged
  to a dead process. The opening closes it `failed` with `interrupted: true`,
  through the same `closeAttempt` as any other ending (an agent attempt without
  figures is marked `cost_unknown`), in its single save, then journals the
  finish. That marker, on the step's last attempt, is what makes admission ask
  for an authorization before replaying the step
  ([Interrupted steps](dsl.md#interrupted-steps)).
- A child reference without `startedAt` is retried under the same `runId`. Once
  `startedAt` is saved, a missing or damaged child snapshot is refused instead
  of becoming a second child (`run/record/child-transitions.ts` owns this rule).
- A settlement lost before its save re-enters the reference: the child is
  terminal, so nothing executes, and the reconciliation charges only the
  difference the `accounted*` figures miss.
- A `RUNNING` snapshot whose steps are all settled is a crash before
  `finalizeRun`: it is resumed and finalized.

`run.status` is written by run creation, a fork (`SUPERSEDED` on the source), `openRun` (back to `RUNNING` when a
`FAIL`, `STOPPED` or `ABORTED` run is resumed), `abortRun` and `finalizeRun`
only. A failed step does not fail the run by itself, and `stopRun` records
`stopped_reason` and `outcome.stop` but leaves `RUNNING`: `finalizeRun` derives
`FAIL` or `STOPPED` once the loop returns.

The write policies differ by file:

- The **snapshot** write is atomic and its failure propagates as an error, so no
  journal event ever describes a state that was not saved.
- The **journal** append is best effort: the first failure is reported once on
  stderr and the run keeps going; only the trace is short.
- The **journal read** is tolerant: an absent or unreadable file reads as empty.

Resuming is idempotent: loading the same run twice reads the same spend,
allocates the same next attempt number, and grows the journal by the
`run.resumed` marker only — a crashed attempt settled by the first load is found
closed by the second.

## The event journal

`events.jsonl` is append-only and holds the journal events below only: a trace
appended after the snapshot of each transition, read by displays and
diagnostics, never by execution. The runner's own output events
(`step.started`, `step.done`, `step.logs`, `runner-event`, …), the bash output
and the raw stream of whatever backend was running go to `feed.jsonl` (its path
is exported to child processes as `RUNNER_LIVE_FEED`), which the watcher pane
and the dashboard's activity line read. A reader that took the raw backend
stream from `events.jsonl` must read `feed.jsonl` instead.

Reading is tolerant line by line and writing is strict. A reader classifies
every line and discards none:

| Line | Classification |
| --- | --- |
| a journal event whose payload passes its schema | `known` — what the typed readers receive |
| a type outside the list below | `unknown` — kept as read, such as an event of a later release |
| a listed type whose payload is refused | `invalid` — kept as read, with the reason |
| not an object, or no string `type`, or unreadable JSON | `skipped` — not an event at all |

The file is read tolerantly too: an absent or unreadable journal reads as
empty, since no decision depends on it. Appending is best effort: the first
failure is reported once on stderr and the run keeps going with a shorter
trace.

`--inspect` prints one journal line for every run it lists, such as
`journal: 110 events, ok (911 live-feed lines ignored)`: the `known` events, then
`invalid` and `skipped` only when they are non-zero (`ok` when both are zero), and
the `unknown` lines as ignored live feed, since they are expected and large. It
names the refused types when there are any; a journal it cannot read is printed
as `journal: unreadable` with the reason. `invalid` points at a producer or schema mismatch; it shortens the timeline,
never a resume.

An optional field of the wrong kind reads as **absent** instead of refusing the
event, the same rule `pipeline-history/runs.jsonl` follows. Only the
fields a reader needs to act on decide validity: `stepId` and a positive integer
`attempt` on the two attempt events, `parentNodeId` and `childRunId` on the
composed-child events. A journal written by a later release, or one carrying a
value this release does not know (`kind: "retry"`, an unknown attempt status), is
kept and read on what it still says.

| Event | Appended when |
| --- | --- |
| `run.started` | a run is created |
| `run.resumed` | an existing `RUNNING` snapshot is resumed; carries `{ pipeline, steps, skip, until }`, the invocation's selectors (null when absent) |
| `run.forked` | a run is created by `--start-at`; carries `{ forkedFrom, startAt, inheritedSpendUsd }` |
| `run.superseded` | a run is closed by a fork; carries `{ supersededBy }` |
| `run.finished` | the verdict is stamped; carries `status` and the full `outcome` |
| `run.stopped` | a gate stopped the run cleanly; carries `phase`, `reason` and `outcome.stop` |
| `run.aborted` | SIGINT/SIGTERM finalization |
| `run.budget.exceeded` | the ceiling stopped the run (see [budgets and timeouts](budgets-timeouts.md)) |
| `run.cost.unaccounted` | a gate withheld work over spend nobody could price |
| `run.unmetered.authorized` | a human authorized unpriceable spend with `--allow-unmetered` |
| `step.skipped` | admission skipped a step, or this invocation's selection left it out (reason `operator selection`); carries `reason`, and `freshness: "fresh"` when the step's stamp decided (reason `up to date`) |
| `step.source.unavailable` | a source the step declares as input could not be read: its stamp is stale and the step runs, or a pass that settled is stamped `null` for it (see [external sources](dsl.md#external-sources)) |
| `step.status.changed` | a step changes status |
| `step.attempt.started` | an attempt opens |
| `step.attempt.finished` | an attempt closes (payload table above) |
| `step.cost.unaccounted` | one attempt spent tokens at an unknown price |
| `pipeline.child.started` | a composed child is launched |
| `pipeline.child.finished` | a composed child is settled |
| `pipeline.child.cost.reconciled` | a child's spend is posted to the parent's ledger |
| `decision.recorded` | `--approve` or `--reject` wrote a new decision at boot: `decision` is `approved` or `rejected`, a rejection also carries `reason` and `round` (a repeated identical decision is not journaled) |

## Scan records

A `--scan` dispatch is not a run: the parent owns no run directory, no
`state.json`, and no `events.jsonl`. It leaves its own record instead, one JSON
file per scan, next to the cross-run history:

```text
.lance-nuit/pipeline-history/scans/<start instant>-<pipeline>-<short id>.json
```

The file holds the pipeline, the provider, the project, the queue, the effective
`--limit`, every discovered ticket, and one state per ticket:

| Ticket state | Meaning |
| --- | --- |
| `pending` | discovered and selected, never started |
| `running` | handed to a child that has not come back |
| `done` | settled, with its `outcome` (`fixed`, `escalated`, `until` for a child stopped at the `--until` bound the scan forwarded, `failed`, `skipped`) and the child's `runId` when it wrote a snapshot |
| `deferred` | discovered but cut by the limit; re-run the scan, or raise `--limit` |

The record is rewritten in full at every transition — before discovery, when
discovery answers, around each ticket, and at the report — not once at the end.
That is what keeps the four states apart on a record an interruption left
behind: written only at the end, three finished tickets followed by a crash
would read as three tickets that never started. A ticket skipped on resume is
`done` with `startedAt` equal to `finishedAt`: it consumed no time of its own.

`finishedAt: null` means the scan never reached its end, and `abort` names the
phase that stopped it. The two are independent, so read both:

| Record | Reading |
| --- | --- |
| `finishedAt` set, `abort: null` | the scan ran to its report; an empty queue counts as complete |
| `finishedAt` set, `abort.phase: "between-tickets"` | the post-ticket checkout refused to leave the tree consistent, so the loop stopped early, but the scan still reported — the untouched tickets stay `pending` |
| `finishedAt: null`, `abort.phase: "discovery"` | the tracker could not answer; `discovered` is `null` and no ticket was ever known |
| `finishedAt: null`, `abort: null` | the process died mid-scan; the `running` ticket is the one that was in flight |

Writing the record is best effort, like statistics emission: a failure is
reported once and the scan continues. The runner never reads the records back.

There is no retention policy: `scans/` grows by one small file per scan, and
`lancenuit clean --logs-only` does not touch it, as it touches nothing else
under `pipeline-history/`. Delete old records by hand when the directory becomes
inconvenient.

## Statistics and retention

At finalization the runner projects one entry per logical `runId` into:

```text
.lance-nuit/pipeline-history/runs.jsonl
```

Resuming atomically replaces that run's line; nothing is mirrored per work item.
Statistics emission is best effort and cannot change the run outcome.
The projection includes status/outcome, phases, models, profiles, tokens, costs,
commit/branch when available, a relative source run directory, and the parent
`runId` when the run was nested. Its cost is the run's `runSpend` at that
moment: `costUsd`, `costUnknown` for a floor, `costStatus: "partial"` for an
amount a rate table produced.

The line is a copy, not the record: the snapshot is. It matters once the
snapshot is gone — its run directory or work item deleted, or written in a
snapshot format this release no longer reads — because the line is kept apart
from the work items and outlives them. The history of a project is therefore
read in one place, `readHistoryRuns` (`run/stats/history-runs.ts`), by
`lancenuit stats` and the dashboard's statistics page alike: every run from its
snapshot while it still reads, with its current `runSpend` — a resume or a
death since the line was written included — and from its line otherwise; a run
not projected yet (in flight, or its emission failed) is read from its snapshot
alone. The two screens therefore list the same runs at the same amounts. A run
read from its line keeps only what the line holds: no active time, no step
statuses.

A nested run gets its own line, but its usage is also folded into its parent's
step: summing every line would count the same spend twice. `parentRunId` is what
separates the two, so a reader must keep root runs only. `lancenuit stats` does
this by default and reports how many nested runs it left out; `--include-children`
lists them when the breakdown itself is the point. A line written before that
field existed carries no nesting information and is read as a root run.

Summarize the history across runs:

```bash
lancenuit stats
lancenuit stats -p release --since 30d
lancenuit stats PROJ-28
lancenuit stats --failures --limit 20
```

The summary answers what a single run's state cannot: what a pipeline has cost,
which phase keeps failing, and where the tokens go per profile. A run's cost is
the one `readHistoryRuns` read: exact when the provider reported it, estimated
when the runner computed it from a rate table (`pipeline-history/pricing.json`
included, applied when each attempt closed), and reported as unavailable rather
than as zero when the run recorded no amount — a total mixing exact and
estimated figures says how many runs were estimated, and how many were left out.
`stats` prices nothing itself: a run the runner could not price stays unpriced,
as it is on the dashboard. Tokens, phases and profiles come from the lines; a
run not projected yet counts in the cost, not in those breakdowns.

Inspect current state and attempt logs with the wrapper:

```bash
lancenuit inspect PROJ-28
lancenuit inspect PROJ-28 --run <run-id>
lancenuit logs PROJ-28 --step tests
lancenuit logs PROJ-28 --run <run-id>
```

`lancenuit clean` requires `--logs-only`; it compresses/removes old per-attempt log
files, preserves `state.json`, `events.jsonl`, snapshots, and central history, and
can retain failed, stopped and interrupted runs with `--keep-failed`. A snapshot
without a verdict that no live process holds counts as interrupted, as it does on
the dashboard.
