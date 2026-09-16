# Budgets and timeouts

This guide describes the limits that bound a run. Agent provider selection and
role policies are covered in [Agents, profiles, and backends](agents-profiles-backends.md).

## Cost ceilings

Declare a positive USD ceiling in the pipeline DSL:

```ts
pipeline("release")
  .maxCost(8)
  .add(/* steps */)
  .build();
```

`.maxCost(usd)` applies to a simple pipeline. The runner accounts for steps,
retries, fixes, and composed child runs. Once the cumulative cost reaches the
ceiling, the run is marked as budget-exceeded and does not start further work.
The ceiling is enforced on the spend the runner could price, and a run whose
spend stops being priceable stops too: see
[Unknown spend stops a capped run](#unknown-spend-stops-a-capped-run).

A ceiling stops the run rather than warning, because an unattended run (`--scan`,
cron) has nobody watching the console. Spending more is a human decision.

The steps left to run stay pending, so the run remains resumable. The console
names the way out:

```text
⚠ Budget exceeded ($5.00 / $5) — 3 step(s) left.
  ↳ To approve a higher ceiling and resume where it stopped, rerun with --budget <usd>
```

`lancenuit run PROJ-1 --budget 20` approves the overrun: the run resumes where the
budget stopped and the steps already completed are neither replayed nor repaid.
The approved ceiling is recorded in the snapshot and applies to later resumes.

Editing `.maxCost()` does not retune a run already in flight — the ceiling stays
pinned to the run, and `--budget` is the one deliberate override. What a resume
restores from the snapshot is the spending already accounted for. The attempt journal
is reconciled too: an attempt priced in the journal but missing from the snapshot,
the trace a hard crash leaves between the two writes, still counts.

A stop decided by the live cost guard (below) is durable too. The guard kills on
an estimate, and the provider's final figure can land under the ceiling; the
snapshot therefore records the stop itself, so a resume without `--budget` halts
where the guard did instead of replaying — and repaying — the killed step.

Either cost stop is also recorded as a fact, not only as a console sentence: the
run outcome carries `stopKind` (`budget-exceeded` or `cost-unaccounted`, see
[persistence](persistence.md)) and the journal carries one
`run.budget.exceeded` / `run.cost.unaccounted` event per stop (see
[sessions and tracing](sessions-tracing.md)). A step killed by a guard keeps its
own `technical` failure kind — that kind drives retry policy at step level — so
the run-level answer is the one to read when telling a cost stop from a broken
process.

A work-item loop uses a per-item ceiling instead:

```ts
pipeline("queue")
  .forEachWorkItem({
    queue: "featureTodo",
    maxCostPerWorkItemUsd: 3,
    do: [/* steps */],
  })
  .build();
```

`maxCostPerWorkItemUsd` gives every discovered or explicitly launched item its
own cap. It cannot be combined with `.maxCost()`; the DSL rejects that
combination. In a composed run, a child can spend at most the smaller of its own
cap and the parent's remaining budget. Child cost is reconciled by difference on
resume rather than charged twice. When the child is the one that stops on
its own cap, the same `--budget` on the parent is the approval: from that resume
on, the child answers to the parent's remaining budget alone, and the approval
sticks to the parent run for later resumes.

## Cost accounting and pricing

Costs are tracked in USD. A provider's result is authoritative when it emits a
cost. If a process is killed before that result, the runner may use an estimate:

- Claude uses its model pricing table and falls back conservatively to Opus for
  an unknown model. Each message is priced at the model that produced it, so a
  run delegating to sub-agents on a cheaper model is not billed at one rate.
- Codex estimates only models it knows; an unknown Codex model has no fallback
  estimate, so the cost can remain unavailable.

A resumed Claude session is charged by difference, like a child run. The Claude
CLI restores the session ledger when it is resumed, so the cost, API duration,
and turn count it reports cover the whole session rather than that one process.
The runner reads the ledger the CLI is about to restore and charges only what the
new process added, so a fix loop resuming an earlier step's session does not
repay that step on every pass, and an overload retry does not repay the attempt
it replaces. Tokens are always read per process and need no reconciliation.

A running agent is also watched live: as usage arrives, the runner compares the
attempt's cost against the remaining budget and kills the process when it crosses
it. The report then names the ceiling rather than reporting a technical error,
and the run stops instead of replaying the step.

The same guard also stops an attempt whose usage is *provably* unpriceable, when
a ceiling governs the run and `--allow-unmetered` was not given: tokens arrived,
no rate covers the model, so this attempt can never be compared to the ceiling.
The kill carries the accounting reason rather than the budget one, the process
group is cleaned up like any other kill, and the step is left resumable. The
proof matters: the absence of usage events is not one. A provider that reports
its price only at completion is not killed for being quiet, and an attempt that
has streamed nothing yet is never stopped on suspicion. Only Codex and opencode
can produce that proof; Claude's table always resolves a rate — an unlisted model
falls back to Opus — so a Claude attempt is never unpriceable in flight.

How often that guard can fire depends on what the provider streams:

| Backend | Guard fires on | Worst-case overshoot |
|---|---|---|
| Claude | every assistant message carrying usage | one message |
| opencode | every `step_finish` | one step |
| Codex | `turn.completed` only | one whole turn |

Codex reports usage only when a turn ends, so a single turn can run past the
ceiling before the guard has anything to measure; the overrun is caught at the
end of that turn. Keep a margin in the ceiling for Codex steps, or split long
steps. The same latency bounds the accounting stop: an unpriceable Codex turn
runs to its end before the guard can prove it unpriceable, so the run can spend
one whole turn at a price nobody will ever know. Telemetry is not billing, and
the runner promises the stop it can prove rather than an exact invoice.

On every backend, an agent attempt that ends without a single usage event — a
timeout, a straggler kill, a `Ctrl+C`, or a transport break before the first
message — is recorded as `cost_unknown`: it spent tokens nobody measured, so the
ledger holds a lower bound and the report says so rather than reading the attempt
as free. Such an attempt marks the total, but it does not stop the run: see
[what counts as unaccounted spend](#what-counts-as-unaccounted-spend).

The same reading applies to a price of `$0` reported over tokens that were
actually consumed, on any backend: tokens alone do not establish a price, and a
zero written by a provider that could not price the model is a gap dressed as a
measurement. Such an attempt is priced from the rate table when one covers the
model — flagged as an estimate — and recorded as `cost_unknown` otherwise. Two
zeros stay truthful: an exact measured zero, where no token was consumed at all
(a shell step, an agent that never reached its provider), and a zero a `pricing.json`
entry produced from explicit zero rates, which is an estimate and remains usable
for the ceiling.

opencode prices a step from the provider's own `cost` field, which it emits on
every step and sets to `0` for any model it cannot price itself (a custom
provider, Copilot, Ollama, a model missing from its catalog). A `cost` of `0` on a
step that spent tokens is therefore read as a missing price, not as a free step:
the live guard and the final figure both fall back to the rate declared in
`pricing.json`, flagged as an estimate. With no rate for the model, the guard
never fires and the attempt is `cost_unknown` rather than $0.00. A step that
reports `0` without a single token — a genuinely free turn — stays an exact zero.
Under a strict ceiling, an opencode step whose price stays unknown is stopped in
flight rather than merely recorded, as described above.

Project pricing can override the built-in tables with
`pipeline-history/pricing.json`, resolved through the kit chain like `config.json`:
`~/.lance-nuit/pipeline-history/pricing.json` holds machine-wide rates and
`<project>/.lance-nuit/pipeline-history/pricing.json` overrides them model by model
(layers merge by key, so a project reprices one model without copying the shared
table). The file must describe USD rates;
`"_currency": "$"` is optional, and a non-USD currency is ignored. Keys are
matched exactly or as model-name fragments. Rate fields are `in`, `out`,
`cacheRead`, and `cacheWrite` (per million tokens). `in` is the non-cached input:
cached reads are billed once, through `cacheRead`. A model the table does not
cover is not priced at zero — the run's cost is reported as unavailable.

This file is optional metadata and does not change the model selected by a
profile. A cost that cannot be measured is not silently converted using another
provider's price.

An attempt whose tokens could not be priced, or an agent attempt interrupted by
a signal before any live estimate reached the runner, is recorded with
`cost_unknown`. The ledger then holds a lower bound: the console report warns
that spend is under-counted, the run's history entry carries `costUnknown`, and
`lancenuit stats` prefixes such totals with `≥` and counts the affected runs.
A Claude transport retry after an overload carries the discarded attempts' cost
into the live estimate, so an interruption during the retry charges the whole
spawn. When the final attempt itself ends without a usage event, the spawn's
figure is the discarded attempts' cost alone and is flagged `cost_unknown`: a
lower bound, not the price.

### Unknown spend stops a capped run

A ceiling can only be enforced against spend the runner could price, so a capped
run stops admitting work as soon as an attempt's spend is unaccounted for. It is
a stop of its own, `cost-unaccounted`, distinct from a budget overrun: nothing
reached the ceiling, the ceiling simply stopped being enforceable. A run under
`.maxCost(5)` with $1.00 of priced spend plus an attempt nobody could price does
not treat the remaining $4.00 as available.

```text
⚠ Spending is unaccounted (≥ $1.00 / $5) — 3 step(s) left.
  ↳ An attempt spent tokens no pricing table could price, so the $5 ceiling cannot be enforced.
  ↳ To authorize spend nobody can price and resume where it stopped, rerun with --allow-unmetered
  ↳ It authorizes the unknown spend only: the known ≥ $1.00 still obeys the $5 ceiling.
  ↳ Pending steps are left resumable.
```

#### What counts as unaccounted spend

The stop needs evidence of unpriceable *consumption*, not merely a marked total.
Two shapes carry `cost_unknown` and only the first one stops the run:

| Shape | Total | Capped run |
|---|---|---|
| Something was measured and no usable price covers it: tokens consumed with no rate, a provider `$0` over spent tokens, an invalid figure, or an amount the backend itself flagged as partial | `≥` lower bound | **stops** |
| Nothing was measured at all: a failed agent attempt that reported neither tokens nor a price — a timeout, a straggler kill, a signal, or a transport break before the first message | `≥` lower bound | **continues** |

The second row is a precaution, not a proof. An attempt that died before its
first message may well have burned tokens, so the total stays a lower bound and
the console still warns — but stopping the run on it would withhold the retries
that are the only way back to a priced attempt: one transient transport failure
would freeze a `.maxCost(5)` run with `retries: 3` at zero retries until a human
passed `--allow-unmetered`. A live cost guard that *proves* an attempt's usage
unpriceable and kills it is evidence, and does stop the run.

The same distinction governs what a resume restores. The stop is rebuilt from the
run's own latch (`cost_unaccounted`) or from the attempts that prove it; a
snapshot written before the latch existed stops exactly like a current one when
its attempts consumed something, and does not when they measured nothing.

The rules around that stop:

- It applies to ordinary steps, reruns, fix passes, and composed child runs, and
  a `blocking: false` step does not absorb it: it is a run-level accounting fact,
  not a step failure to repair.
- Every composed launch passes the same gate as a step admission: each child of a
  `runPipeline` or `forEachPipeline` node, and each `afterEach`/`afterAll`
  callback. A fan-out therefore stops at the item that made the ceiling
  unenforceable — the items it had not reached keep no child run and stay
  pending, and the callbacks are not called. Resuming after the authorization
  picks the list up where it stopped.
- Pending steps stay pending, exactly as for a budget overrun, so the run
  remains resumable and settled steps are neither replayed nor repaid.
- The uncertainty is restored with the totals on resume. A new generation does
  not clear it by starting a fresh ledger over the same spend, and raising
  `--budget` changes the amount only — it does not make a past attempt priceable.
- `--budget` on a run that had **no** ceiling when it spent stops that run. An
  uncapped run records the uncertainty and continues, because it has no ceiling
  to lose; the moment `--budget 10` gives it one, the amount is enforceable
  against nothing and the run stops as `cost-unaccounted` on its next admission.
  This is the same rule, not a special case: the latch describes the spend, not
  the previous generation's verdict. Pass `--allow-unmetered` alongside
  `--budget` to cap the priced spend and authorize the rest in one invocation.
- A run that completed every step is not failed after the fact. There is nothing
  left to withhold; the spend is still reported as a lower bound.
- An uncapped run is unaffected: with no ceiling to enforce, it keeps the warning
  and continues.

Declaring rates in `pricing.json` prices later attempts, not one already closed
as unknown. An estimate is usable for the ceiling; an unknown is not.

The final report says so in its own words rather than borrowing the failure or
budget ones, and prints the command that lifts the stop:

```text
╭─ ! COST UNACCOUNTED · release · PROJ-1
│  Spending unaccounted
│  1 completed · 1 not run
│  Budget ≥ $1.00 / $5.00
│  ⚠ At least one attempt had no computable cost: spend is under-counted
╰─ Authorize the unknown spend to resume where it stopped; the known spend still obeys the ceiling.
   ↻ lancenuit run PROJ-1 --pipeline release --allow-unmetered
```

That headline belongs to the runs the stop actually ended — one where a gate
withheld the next step, retry, fix pass, child, or callback. A run whose step
failed for its own reason keeps its own headline (`FAILURE`, or `QUALITY CHECK`
for a verdict) even when its ledger is a lower bound: the reason an operator has
to act on is the failure, and `--allow-unmetered` would not touch it. A reached
ceiling still outranks both. The `≥` on the total is printed in every case.

An unknown spend is never shown as an exact figure anywhere: the console, the run
history and `lancenuit stats` all prefix such a total with `≥`.
A run whose only spend was unpriceable reads `≥ $0.00`, not `$0.00` — the second
would claim it was free. Authorizing spend nobody can price is a decision taken
at the terminal, on purpose.

### Authorizing unmetered spend

`lancenuit run PROJ-1 --allow-unmetered` is the deliberate way past that stop. It
authorizes the *unknown* portion and nothing else:

- The spend the runner could price keeps answering to the ceiling. An authorized
  run whose priced total reaches `.maxCost()` stops as `budget-exceeded`, exactly
  as an unauthorized one does.
- No unknown marker is cleared and the total is never relabelled exact. The
  snapshot keeps `cost_unaccounted`, and the report keeps reading the total as a
  lower bound.
- The authorization is recorded on the run it was given to (`allow_unmetered` in
  the snapshot, plus one `run.unmetered.authorized` journal event), so later
  resumes of that run continue without the flag. `--fresh` is a different run and
  starts strict again.
- It propagates down the budget scope: authorizing a root authorizes the children
  it composes, which never need the flag themselves. The reverse is refused — a
  composed child resumed directly with `--allow-unmetered` under an ancestor's
  ceiling cannot grant itself what its scope withheld, and the console names the
  run to authorize instead. That refusal is deliberately conservative: a child's
  snapshot records the resulting ceiling, not which ancestor imposed it, so a
  capped child resumed outside its orchestration is refused even when the cap was
  its own pipeline's. Authorize such a child through its root. A directly resumed
  child with no ceiling at all takes the flag: there is no strict policy to
  weaken.
- `--budget` is not an alternative. It changes the amount; it does not authorize.
  Both can be given together, and then each answers for its own half.
- Like `--budget`, it is refused on an inspection command and under `--scan`: an
  authorization is a decision about one run, not about every ticket a sweep finds.

Telemetry is not billing. A provider can report a figure late or not at all, so an
authorized run can overshoot what the ceiling would have allowed. The runner
promises the stop it can prove, not an exact invoice.

### Where spend is written

One module writes every figure the runner accounts for:
`src/state/cost-accounting.ts`. It also owns the reads that say what a figure
proves, so changing a cost rule means changing that file and checking the
behaviors it names, rather than looking for whoever else might touch a budget.

Four facts move money, and each has its own entry point there:

| Fact | Entry point | Written |
|---|---|---|
| An attempt closes (loop, signal handler, or a crash settled on resume) | `chargeClosedAttempt` | the attempt's own figures, and the step total that seeds the ledger on resume |
| The same attempt reaches the run ledger | `chargeAttemptToLedger` | the cumulative total and the accounting latch derived from it |
| A composed child reports an aggregated cost the parent never saw as attempts | `chargeChildReconciliation` | the orchestration node's total, the parent ledger, and one `pipeline.child.cost.reconciled` event |
| A resume reads figures back from the snapshot and the journal | `projectStepSpend`, `restoreAttemptSpend`, `restoreRunTotals` | nothing new — a total already accounted for is rebuilt or restored, never charged again |

`chargeAttemptToLedger` is purely arithmetic and performs no I/O: the attempt
lifecycle (`finishAttempt` in `src/step/step-attempt.ts`) calls it with the
figures `closeAttempt` accepted, on every exit of an attempt — a returned verdict
or a rejected spawn alike — and the gate that decides to stop is what journals
the stop. The charge is not a middleware: nothing in the optional attempt chain
can skip it or absorb its failure. Summing two sets of figures is private to the
module, so there is no way to add spend to a step, an attempt, or the ledger from
outside it. A run's `total_control` and `total_usage` remain derived values,
recomputed from the steps when a run is finalized or aborted, restored by a
resume only from a terminal snapshot (`restoreRunTotals`), and dropped by every
charge that reaches the run — an attempt to the ledger or a child
reconciliation. Which record a resume believes for each concept is tabled in
[persistence](persistence.md#which-record-is-authoritative).

## Wall-clock timeouts

Without an explicit step timeout, the defaults are:

| Step/process | Default |
|---|---:|
| Bash step | 600 seconds (10 minutes) |
| Agent process (Claude, Codex, or opencode) | 900 seconds (15 minutes) |

Set a per-step timeout in seconds:

```ts
bashStep({ id: "tests", name: "Tests", command: "npm test", timeout: 300 });
```

The timeout kills the supervised process tree. It is distinct from a cost
ceiling: a timeout is a technical failure, while exhausting `maxCost` stops the
run because its financial limit has been reached. An `onFail.escalate.model`
policy can switch model directly after a timeout; ordinary retry escalation can
increase effort before changing model. See
[Failures, retries, and capacity escalation](failures-retries-escalation.md).

If `stackPreflight` is configured, Docker readiness has its own budget, outside
step timeouts. Its default readiness window is 300 seconds; `startCommand` and
`readinessTimeoutMs` can be changed in `.lance-nuit/config.json`.

## Informational output-token signal

`usTokenBudget` is not a kill switch, and the runner does not act on it: it is an
output-token threshold declared in `.lance-nuit/config.json`, read from the
configuration and exposed to pipelines through the context. The default is
`150000`:

```json
{ "usTokenBudget": 120000 }
```

A pipeline that wants to compare it against the tokens a step consumed does so
itself. Nothing in the loop compares, reports, or enforces it: it never prevents
a retry or a subsequent step.

## Policy fields are not budgets

The optional `planAudit` configuration flag controls a policy step; it does not
impose a cost or time limit. The package's current `default` pipeline does not
consume it: it contains only the neutral `ready` Bash step. If a project pipeline
uses this flag, document that behavior next to the pipeline; merely setting it
does not modify the built-in `default`.
