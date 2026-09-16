# Persistence

The runner separates business data, human decisions, and run telemetry. A work
item normally looks like this:

```text
.lance-nuit/work-items/<ticket>/
├── artifacts/                 # durable business outputs (JSON, Markdown, inputs/…)
│   ├── ticket.md              # tracker snapshot used as pipeline input
│   ├── inputs/                # optional human-provided files
│   └── .provenance/           # runner-owned input fingerprints, one per output
├── reports/                   # disposable machine/human reports
│   └── <LOT-ID>/              # isolated reports for a batch sub-run
├── decisions/                 # hash-locked approval records
└── runs/<pipeline>/
    ├── latest -> <run-id>     # authoritative resumable selector
    └── <run-id>/
        ├── state.json
        ├── events.jsonl       # append-only event journal and live feed
        └── steps/<step>/attempt-001/output.log
```

`ctx.paths.artifactsDir`, `ctx.paths.reportsDir`, and
`ctx.paths.decisionsDir` are the canonical paths. Steps and skills should use
these context paths rather than rebuilding paths from a ticket name.
`artifacts/.provenance/<name>.json` is written by the runner for every output of a
step that declares `input`, and the prefix is reserved: an artifact descriptor
cannot claim a name inside it. A record binds one artifact to the bytes it came
from:

```json
{
  "schemaVersion": 1,
  "artifact": "artifacts/spec.md",
  "producedBy": "spec",
  "producedAt": "2026-09-03T12:00:00.000Z",
  "inputs": { "artifacts/ticket.md": "<sha256>" }
}
```

An input absent when the record was written is stored as `null`, so its
reappearance invalidates the record instead of being silently adopted. A batch
(`lot`) receives `reports/<LOT-ID>/`; other
phases use the work-item's flat `reports/` directory. Artifact descriptors read
and write through `ctx.artifacts`, which validates names and keeps the logical
interface independent of the filesystem.

A project pipeline can split a parent plan into lots without creating a dispatch
run for each lot. The generic resolver also supports explicit nested work-item
paths and the `PROJ-28-01 → PROJ-28/US-01` mapping when that directory layout is
present. Such a child has the same `artifacts/`, `reports/`, `decisions/`, and
`runs/` families.

## Run snapshots and resume

The reader accepts schema version 1, validates the full structure, and fails
closed on any other version. Keep the matching event journals when moving runs to
an installed package: a snapshot alone does not contain the attempt history.

`state.json` is written as schema version 1 and contains the durable run state: step status,
retries, sessions, profile attribution, usage/cost control data, the highest
attempt number allocated per step (`last_attempt`), and the run-level verdict,
totals, and cost decisions. It does **not** carry the attempts or the last
rendered command: the attempts are projected from the journal on resume, and the
command is the whole agent prompt, kept in memory only (`state/run-repository.ts`
is the one writer of the snapshot, and `model/run.ts` marks both fields as
runtime-only). The pipeline definition and configuration are reloaded when a run
resumes, while persisted step state (including the profile and session) is
retained for correct attribution. Which of the two files is believed when they
disagree is settled per concept in [Which record is authoritative](#which-record-is-authoritative).

Resume is a boot step (`boot/resume.ts`): it loads the definition, applies the
`--step`/`--skip`/`--start-at` selectors, and assembles the in-memory run from the
definition and the projected state. `state/` only reads, projects and reconciles
(`state/run-projection.ts`): it reconciles each persisted step with the attempts
the journal holds and settles the attempts a crash left running, without ever
knowing about a pipeline definition.

Readers validate a snapshot against a runtime schema (`state/schema.ts`) that
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

- `worktree` and `cwd` say where the run executed — `cwd` is the effective
  working directory after the worktree `chdir`, which is the tree whose
  `artifacts/` and `decisions/` the run reads and writes. A resume from another
  place rewrites both.
- `outcome.stop` describes a clean stop without making a reader parse
  `stopped_reason`: `detail` is the reason without the console decoration,
  `kind` is the expected recovery (`needs-info`, `needs-decision`, `needs-human`,
  or `blocked` for a step whose `fail_cause` says so), and `subject` is the
  approval subject that lifts the stop when the gate declares one. The same
  object is attached to the `run.stopped` journal event.
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
  it stops with `cost-unaccounted` unless it is authorized. It is a projection of
  the reconciled attempts made durable, so a snapshot written before the field
  existed still stops: the ledger reads the same fact from the attempts' own
  `cost_unknown`, and the next generation writes the latch.
- `allow_unmetered` records that a human authorized that unknown spend with
  `--allow-unmetered`. It lifts the accounting stop only: `max_cost_usd` still
  governs what the runner could price. Absent means strict — a missing
  authorization is never read as permissive. It is propagated to the children
  launched in the run's budget scope, and a composed child cannot set it for
  itself while an ancestor's ceiling governs it.

All of these are optional and the writer keeps schema version 1: a snapshot written
before they existed remains valid, and a stop raised by an admission that
describes nothing carries `stopped_reason` alone.

Each attempt gets its own log; resuming never truncates `events.jsonl`. The
`latest` symlink is reused only when its snapshot is resumable (`pending`,
`running`, `failed`, or `aborted` work remains). A completed (`PASS`) run is not
resumed; a run interrupted by SIGINT, stopped cleanly at a gate, or stopped by its
budget is, since each keeps the work it had left to do. A run whose steps are all
settled but that never received a verdict — a crash or a Ctrl+C in the window
between the last step snapshot and finalization — is also resumed, so the next
invocation stamps its verdict instead of replaying the whole pipeline. Use
`--fresh` to force a new timestamped run, or `--run <runId>` to select an
existing run explicitly for inspection, logs, or resume.

A run directory is held by a single writer: `runner.lock` records the owning pid,
and a dead holder is reclaimed automatically. Reclaiming a stale lock goes through
the same protocol as the project-wide runner lock, so two runners that find the
same dead holder cannot both take the directory. `--run <runId>` fails when another
live runner holds the target; an implicit resume of `latest` reports the holder
and starts a new run instead, since the work in the held directory is intact and
this invocation is simply not its writer.

Two details of that lock file are worth knowing when reading one by hand:

- Next to the pid, the payload carries a `lockNonce` field: a random value
  generated once per process. Ownership is the pid *and* that nonce, so a lock is
  released only by the process that published it — an operating system reassigning
  a dead runner's pid to a new one cannot make the new process look like the
  holder, nor let it free a lock it never took. The field is written by the lock
  itself; nothing else reads it.
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
detected when the run is resumed. The three paths go through the same writer
(`state/attempt-closure.ts`), which sets the attempt status and `finished_at`,
normalizes its control data, charges it (see
[Where spend is written](budgets-timeouts.md#where-spend-is-written)), and appends
one `step.attempt.finished` event. A second closer finds the attempt no longer
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
| `stepId`, `attempt`, `kind` | always | step, attempt number, and `step` or `fix` |
| `status` | always | `done`, `failed`, or `aborted` |
| `control` | always | normalized control data, including `cost_unknown` / `cost_estimated` |
| `logPath` | always | attempt log, run-relative |
| `sessionId`, `session` | when the backend reported one | session reference and the full session object, so a resume can project the attempt without the snapshot |
| `provider`, `model` | when known | from the control data, or the session for the provider |
| `costUsd` | when priced | `control.total_cost_usd`; an abort carries its live estimate |
| `usage` | when measured | token counts |
| `reason` | on failure or abort | error text, or the abort reason |

Readers should not infer the ending from which fields are present (an aborted
attempt carries `costUsd` and `usage` when it has them); `status` and `reason`
are the discriminators.

### Which record is authoritative

A resume reads two files that were written at different instants, and a crash
can leave either one behind the other. Rather than rebuilding everything from the
events, each concept has one authoritative record, and a documented rule for the
case where the other record knows more. `boot/resume.ts` assembles the run from
the definition and the projection; `state/run-projection.ts` and
`state/attempt-projection.ts` apply the rules below; `state/cost-accounting.ts`
owns the spend rules among them (`projectStepSpend`, `restoreAttemptSpend`,
`restoreRunTotals`). None of them charges anything: a figure read back is a
projection of spend already accounted for when the attempt closed.

| Concept | Authority | Derived from it | When the other record knows more |
| --- | --- | --- | --- |
| Step status, timestamps, reason | snapshot | — | A **terminal** `step.status.changed` (`done`, `failed`, `skipped`, `aborted`) over an **unfinished** snapshot status (`pending`, `running`) wins, with the event's instant, reason and fail cause. One-way only: a terminal snapshot is the later record, and a journal that walked the step back to `running` describes a pass the snapshot has since closed. |
| Attempts (number, kind, status, session, log path, own figures) | journal (`step.attempt.started` / `step.attempt.finished`) | in-memory `step.attempts`; the next attempt number | The snapshot holds none. A finish without its start is kept (the numbering must not shift); an attempt still `running` at load is settled by `settleCrashedAttempts` as failed and unpriced, through the same `closeAttempt` as any other ending, and the finish is journaled so the next resume projects it instead of deciding again. |
| Attempt numbering floor | snapshot `last_attempt` | next attempt = max(`last_attempt`, journaled attempts, list length) + 1 | The journal cannot lower it. It is kept precisely for the journal that lost an attempt (a failed append, a rewritten file): without it a resume would reuse a number and append into an existing log. It stays until a replacement proves the same guarantee with an incomplete journal. |
| Step spend total (`control`, `usage`) | snapshot | budget ledger seed on resume | The journal wins **only when its priced sum exceeds the snapshot's** (`projectStepSpend`): the finish event is appended before the snapshot, so a crash in that window leaves a priced attempt the step total never received. An attempt lost with no price in the journal does not change the total: the snapshot stays the record, and the attempt keeps its own figures where they were read. |
| Run totals (`total_control`, `total_usage`) | derived from the steps | materialized by `finalizeRun` and `abortRun`; read through `controlForRun` / `usageForRun` | Trusted on a **terminal** snapshot only (finalized, and no executable step left under the current definition); dropped on a live resume (`restoreRunTotals`). Every charge that reaches the run — an attempt to the ledger, a child reconciliation — drops them too, so a total from a previous generation never hides spend incurred after it. |
| Run status, outcome, `aborted`, `stopped_reason` | snapshot | — | Restored as persisted on a terminal snapshot; on a live resume they describe the previous invocation's ending and are reset to a running state. A `RUNNING` (or resumable `ABORTED`) snapshot whose steps are all settled is not terminal: it owes a `finalizeRun`, and is loaded live so the next invocation stamps it. |
| `budget_exceeded`, `cost_unaccounted`, `allow_unmetered`, `budget_approved` | snapshot | budget ledger flags on resume | The journal is a trace, never the source. `--budget` clears `budget_exceeded` and nothing else; `cost_unaccounted` is a latch nothing clears, and a snapshot written before it existed reads the same fact from the attempts' `cost_unknown`; a new `--allow-unmetered` is applied once at boot and journaled then. |
| Composed child reference (`status`, `runId`, `outcome`, in the parent snapshot) | parent snapshot | — | The parent's own progress record for one child call, written by `state/child-transitions.ts`: `done` and `skipped` are final and never re-entered; `pending`, `running` and `failed` are re-entered by the next generation under the same bound `runId`. The child run's verdict lives in the child snapshot; the reference carries a copy of its outcome as the parent step's answer. |
| Composed child identity (`pipeline.child.started`) | journal | — | The reference's `runId` alone is not proof the child started; the start fact lives in the journal only, which is why an unreadable journal fails the resume instead of reading as empty. |
| Composed child spend (`accountedCostUsd`, `accountedDurationMs`, `accountedUsage`) | parent snapshot | the parent node's `control` and `usage`, the parent ledger | What the parent already charged for this child (`chargeChildReconciliation`). A resumed child re-reports its whole history and is charged by difference; a reference reloaded from a snapshot written before the last reconciliation is charged the missing difference again, never twice. |
| Location (`worktree`, `cwd`) | snapshot | — | Rewritten by every resume with the invocation's own location. |
| Selection (`excluded`, skipped steps) | snapshot, then the current selectors | — | `--step` / `--skip` / `--start-at` apply on top of the persisted state to every step that still owes work, including steps the definition gained since the snapshot. |

### Interruption windows

Every transition appends its journal event, then writes the snapshot through a
temporary file and rename. A crash therefore leaves one of three states: neither
written, the event alone, or both. The event-alone window is the one the rules
above exist for:

| Transition | Order | Event alone leaves | Resolved on resume by |
| --- | --- | --- | --- |
| Attempt start (`runTrackedAttempt`) | attempt pushed in memory → `step.attempt.started` → snapshot (`last_attempt`) | an attempt the journal calls `running` and the snapshot never numbered | `settleCrashedAttempts` closes it failed and unpriced, journals the finish; the number is taken from the journal |
| Attempt end (`finishAttempt`) | `closeAttempt` (`step.attempt.finished`, step total in memory) → verdict → ledger → snapshot | a priced attempt absent from the step total | `projectStepSpend` rebuilds the step total from the journal when it holds more |
| Step status (`updateStep`) | `step.status.changed` → snapshot | a step the journal finished and the snapshot still runs | `reconcileStepStatus`, terminal event over unfinished snapshot |
| Clean stop / interruption / verdict (`stopRun`, `abortRun`, `finalizeRun`) | event → snapshot | a `run.finished` (or `run.stopped`, `run.aborted`) with a snapshot that still says `RUNNING` | the settled-but-unfinalized rule: the run is resumed and finalized again, so the journal carries a second `run.finished`; readers take the last one |
| Composed child launch (`bindChildRun`, `recordChildStarted`) | parent snapshot (reference `running`, bound to its `runId`) → child run booted (child snapshot) → `pipeline.child.started` | a reference with a `runId` and no start event, or a start event with a child snapshot that later went missing | the reference alone is not proof the child started, so the parent retries the initialization under the same id; once the start event is durable, a missing or damaged child snapshot is refused instead of becoming a second child (`state/child-transitions.ts` owns this rule) |
| Composed child settlement (`settleChild`) | `chargeChildReconciliation` (`pipeline.child.cost.reconciled`, node total and ledger in memory) → `pipeline.child.finished` → parent snapshot | a finished, reconciled child the parent snapshot still calls `running`, with `accounted*` figures behind the charge | the reference is re-entered: the child snapshot is terminal, so nothing executes; the reconciliation charges the difference the snapshot missed, and the settlement is journaled again — readers take the last `pipeline.child.finished` |

A crash **before** the event leaves nothing of the transition: the attempt never
existed, the step keeps its previous status, and the resume replays it. One
side effect can survive: the attempt's log directory is allocated before the
start event, so an orphan `attempt-NNN/` may be reused by the replayed attempt.

The write policies differ by file, and that asymmetry is deliberate:

- The **snapshot** write is atomic and its failure propagates as an error: the
  store never swallows it, so the transition that asked for the write decides.
- The **journal** append is best effort: the first failure is reported once on
  stderr and the run keeps going. What is lost is the attempts and the child
  start facts of that window; the step totals and `last_attempt` in the snapshot
  keep the spend and the numbering, so a later resume is short of history, not
  of money. Turning a failed append into a hard stop is a functional decision
  with consequences on every run whose journal sits on a full or read-only
  disk, not a refactoring: the current policy stands until that decision is
  made explicitly.
- The **journal read** is strict: an absent file is an empty journal, any other
  failure throws, because an unreadable journal read as empty would restart the
  attempt numbering and let a parent launch a second child under the same
  identity.

Resuming is idempotent under these rules: loading the same run twice reads the
same spend, allocates the same next attempt number, and grows the journal by the
`run.resumed` marker only — a crashed attempt settled by the first load is found
closed by the second.

## The event journal

`events.jsonl` is append-only and is also the live feed, so one file holds three
kinds of line: the journal events below, the runner's own output events
(`step.started`, `step.done`, `step.logs`, `runner-event`, …), and the raw stream
of whatever backend was running. Only the first kind is a contract.

Reading is tolerant line by line and writing is strict. A reader classifies
every line and discards none:

| Line | Classification |
| --- | --- |
| a journal event whose payload passes its schema | `known` — what the typed readers receive |
| a type outside the list below | `unknown` — kept as read; this is most of a real journal |
| a listed type whose payload is refused | `invalid` — kept as read, with the reason |
| not an object, or no string `type`, or unreadable JSON | `skipped` — not an event at all |

Line tolerance stops at the file: an absent journal reads as empty, because
a run that has not written yet has none, but any other read failure
(permissions, I/O, a directory in its place) throws. The journal is the only
holder of the attempts and of `pipeline.child.started`, so a resume that read
an unreadable journal as empty would restart the attempt numbering, and a
parent would start a second child under the same identity. Appending stays
best effort: the first failure is reported once on stderr and the run keeps
going, with those facts lost for a later resume (see
[Interruption windows](#interruption-windows) for what the snapshot still
guarantees in that case).

`--inspect` prints the four counters for every run it lists, and names the
refused types when there are any; a journal it cannot read is printed as
`journal: unreadable` with the reason. `unknown` is expected and large. `invalid` is
the number that matters: on a `step.attempt.*` it means the attempt is missing
from the projections a resume rebuilds. The concrete loss is accounting, not log
paths — `nextAttemptLogPath` also seeds from the step's `last_attempt`, so
numbering does not silently restart at 1 — but a closed attempt is journaled
*before* the snapshot is written, so a crash in that window leaves its price in
the journal alone: an event refused whole reads as a free attempt, and the resume
can then spend past `max_cost_usd`.

That is why an optional field of the wrong kind reads as **absent** instead of
refusing the event, the same rule `pipeline-history/runs.jsonl` follows. Only the
fields a reader needs to act on decide validity: `stepId` and a positive integer
`attempt` on the two attempt events, `parentNodeId` and `childRunId` on the
composed-child events. A journal written by a later release, or one carrying a
value this release does not know (`kind: "retry"`, an unknown attempt status), is
kept and read on what it still says.

| Event | Appended when |
| --- | --- |
| `run.started` | a run is created |
| `run.resumed` | an existing `RUNNING` snapshot is resumed |
| `run.finished` | the verdict is stamped; carries `status` and the full `outcome` |
| `run.stopped` | a gate stopped the run cleanly; carries `phase`, `reason` and `outcome.stop` |
| `run.aborted` | SIGINT/SIGTERM finalization |
| `run.budget.exceeded` | the ceiling stopped the run (see [budgets and timeouts](budgets-timeouts.md)) |
| `run.cost.unaccounted` | a gate withheld work over spend nobody could price |
| `run.unmetered.authorized` | a human authorized unpriceable spend with `--allow-unmetered` |
| `step.skipped` | an input decision skipped a step |
| `step.status.changed` | a step changes status |
| `step.attempt.started` | an attempt opens |
| `step.attempt.finished` | an attempt closes (payload table above) |
| `step.cost.unaccounted` | one attempt spent tokens at an unknown price |
| `pipeline.child.started` | a composed child is launched |
| `pipeline.child.finished` | a composed child is settled |
| `pipeline.child.cost.reconciled` | a child's spend is posted to the parent's ledger |
| `decision.recorded` | an approval was consumed at boot |

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
| `done` | settled, with its `outcome` (`fixed`, `escalated`, `failed`, `skipped`) and the child's `runId` when it wrote a snapshot |
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
reported once and the scan continues. Reading is tolerant — a file that is
unreadable, is not JSON, or does not match the schema is counted as skipped
rather than hiding every other scan.

There is no retention policy: `scans/` grows by one small file per scan, and
`lancenuit clean --logs-only` does not touch it, as it touches nothing else
under `pipeline-history/`. Delete old records by hand when the directory becomes
inconvenient.

## Statistics and retention

At finalization the runner projects one entry per logical `runId` into:

```text
.lance-nuit/pipeline-history/runs.jsonl
```

Resuming atomically replaces that run's line. This central file is the only
run-statistics projection; nothing is mirrored per work item. Statistics emission
is best effort and cannot change the run outcome.
The projection includes status/outcome, phases, models, profiles, tokens, costs,
commit/branch when available, a relative source run directory, and the parent
`runId` when the run was nested.

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
which phase keeps failing, and where the tokens go per profile. Cost is exact when
the provider reported it, estimated when the runner computed it from a rate table
or when `stats` derives it from `pipeline-history/pricing.json`, and reported as
unavailable rather than as zero when neither applies — a total mixing exact and
estimated figures says how many runs were estimated, and how many were left out.
Every figure is in USD: a `pricing.json` declaring another `_currency` is ignored
here as it is by the runner, so its runs count as unpriced instead of adding
euros to dollars.

Inspect current state and attempt logs with the wrapper:

```bash
lancenuit inspect PROJ-28
lancenuit inspect PROJ-28 --run <run-id>
lancenuit logs PROJ-28 --step tests
lancenuit logs PROJ-28 --run <run-id>
```

`lancenuit clean` requires `--logs-only`; it compresses/removes old per-attempt log
files, preserves `state.json`, `events.jsonl`, snapshots, and central history, and
can retain failed/interrupted runs with `--keep-failed`.
