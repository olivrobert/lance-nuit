# Agent sessions and tracing

Agent backends expose a normalized session reference:

```ts
{ provider: string; id: string; resumable: boolean }
```

The reference is persisted in `step.session`. Claude receives a UUID through `--session-id` and
can be resumed with `claude --resume <uuid>`. Codex returns its thread ID and can
be resumed with `codex exec resume <id>`. opencode returns a `ses_…` ID and can
be resumed with `opencode run -s <id>`. A resume is provider-specific: the
runner never sends a Claude session ID to Codex or vice versa, and it does not
automatically change provider when a session cannot be resumed.

Only Claude accepts an ID chosen by the runner before the spawn. Codex and
opencode mint their own and report it afterwards, so their session reference only
exists once a step has answered.

Every agent step records its session in `step.session`. An `onFail` policy with
`resumeSession: "<stepId>"` reopens the session recorded by that step, within the
same run, when its provider supports it; otherwise the repair starts a fresh
session, as defined in
[`failures-retries-escalation.md`](failures-retries-escalation.md).

Providers disagree on what a resume does to the parent conversation:
`claude --resume` branches, while `opencode run -s <id>` appends in place. A
repair pass therefore asks opencode for `--fork`, so the conversation that
produced the code survives the repair attempts: the forked ID is written back as
the session of the resumed step, so a later `resumeSession` on the same step
continues the repaired conversation, and the parent remains consultable under its
own ID. The `fork` option forces either behaviour when a pipeline needs it.

## What is persisted

For each step the runner records the session, provider usage, and step totals
in `state.json`, and every attempt with its log path in `events.jsonl` (see
[which record is authoritative](persistence.md#which-record-is-authoritative)).
Attempt output is stored at:

```text
runs/<pipeline>/<run-id>/
├── state.json
├── events.jsonl
└── steps/<step>/attempt-001/output.log
```

The event journal is append-only and is also the live feed; a resume does not
truncate it. Its event types and the way a reader classifies the lines it does not
recognize are described in [persistence](persistence.md#the-event-journal). Cost
uncertainty is traced there rather than only on the console:
`step.cost.unaccounted` records each attempt whose tokens could not be priced,
and `run.unmetered.authorized` records the one moment a human authorized
that spend with `--allow-unmetered` — once per run, when the authorization
changes.

The two ways a cost policy can end a run are recorded as facts of their own, so a
post-mortem never has to parse a console sentence:

| Event | Appended when | Payload |
|---|---|---|
| `run.budget.exceeded` | the ceiling stopped the run: the ledger of closed attempts reached `max_cost_usd`, or a live guard killed an attempt for crossing what was left of it | `stepId`, `cumulativeUsd`, `maxCostUsd`, `estimated`, `remainingSteps` |
| `run.cost.unaccounted` | a gate withheld work because spend was measured that no pricing table could price: step admission, a retry, a fix pass, a composed child launch, a loop callback, or a live accounting guard | `stepId`, `cumulativeUsd` (a lower bound), `maxCostUsd`, `remainingSteps` |

`estimated: true` means the stop rests on a figure the provider never confirmed —
a live guard fires on its own running total, so `cumulativeUsd` can sit under the
ceiling. Each event is appended **once per stop**: several gates observe the same
decision in a row, and a resume that decides again appends its own event. A
refused composed launch is journaled on the run that owns the ceiling, not on the
child that never started. The run's snapshot carries the same fact as
`outcome.stopKind` (see [persistence](persistence.md)), and `run.finished`
inherits it with the rest of the outcome.

Execution messages travel the same channel. The step loop publishes them as
`runner.message` events on its output port, so each one carries a `level` —
`info`, `warn` or `error` — beside its text: the console prints the glyph of that
level (`⚠` for `warn`, `✗` for `error`, nothing for `info`) and the feed keeps
the field, which is what makes a warning greppable instead of a glyph to match
on. Severity is not a verdict: a `warn` says a gate degraded something, never
that the run ends badly. Only severity is carried by the level. The prefixes that
classify a line rather than rank it — `⊘` a skipped step, `⏹` a clean stop, `📄`
a log path, `→` a transition — stay inside `message`, where they are part of the
sentence.

Not every message has a port to publish on. A site that holds no `RunOutput`
writes to stderr directly through `log.warn`/`log.error`, and those sites are not
only the phases that run before the fan-out exists (boot, dispatch, the entry
point itself): a few helpers reached from inside a run are in the same position,
notably the attempt lifecycle that warns when spend could not be priced (`Cost
not computable … the ceiling is no longer guaranteed`), the warning about a stale
report that could not be removed, and the notice that a resumable run directory
is held by another process. Those lines reach the console with their glyph but
**not** `events.jsonl`, so a post-mortem reading only the feed will not see them.
A message never takes both paths, so nothing is ever printed twice.

Claude may expose a session file location, which the final report includes when it
can resolve one. Codex and opencode currently report their session ID but no local
session location through the backend contract.

During execution, the console prints the session ID and the step log path. On
completion or failure it prints the backend's resume command when available. The
final report includes a `Resumptions` section for persisted session references and
a `Files` section for the run snapshot, journal, logs, and history projection.

## Inspect a run

The wrapper's diagnostics are subcommands, not flags in the public examples:

```bash
# Latest top-level run of every pipeline for this ticket; sub-runs spawned by
# forEachPipeline appear as one indented line each under their parent
lancenuit inspect PROJ-28

# A specific run ID
lancenuit inspect PROJ-28 --run <run-id>

# All attempts, or one step
lancenuit logs PROJ-28
lancenuit logs PROJ-28 --step tests
lancenuit logs PROJ-28 --run <run-id>

# Remove old per-attempt logs only
lancenuit clean --logs-only --older-than 30d --keep-failed
```

There is no `--session` diagnostics option. To inspect a session, use the run ID
to find the persisted step/session mapping, then the backend's printed resume
command or its own CLI. `--run` also explicitly selects the run for a future
resume.
