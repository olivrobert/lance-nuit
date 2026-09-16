# Failures, retries, and capacity escalation

There are two different meanings of escalation in the runner. This guide covers
the technical one: retrying a failed step with more agent capacity. Moving a ticket
to a human queue is a separate workflow described in
[`human-control.md`](human-control.md).

## The failure lifecycle

For each step the runner:

1. evaluates `when` admissions;
2. evaluates `require` as an environment guard, before spawning anything;
3. executes one attempt;
4. validates its exit status/verdict and declared outputs;
5. applies `onFail`, if the attempt failed.

An extractor can enrich a fix prompt, but it never turns a non-zero command into a
successful step.

## Blocked: a failure no repair can clear

A step whose failure carries `fail_cause: "blocked"` stops the run cleanly instead
of spending repair attempts on an obstacle outside the code. An agent declares that
cause with `"blocked": true` beside `success: false` in its verdict:

```json
{"success": false, "reason": "the release branch does not exist", "blocked": true}
```

`blocked` is the canonical field. The prose form — a `reason` starting with
`BLOCKED:` and no `blocked` field — also sets it, so a prompt or extension backend
can state the obstacle in text. The explicit field wins in both
directions: `"blocked": false` with a `reason` that quotes `BLOCKED:` is not a block.
`"blocked": true` alongside `success: true` is ignored, with a warning: a step that
succeeded has nothing to stop.

The cause is read from the signal the runner retains, never from a stray one. A
blocked verdict left in the output of an attempt a timeout or the cost guard killed
does not stop the run as blocked: the kill is what ended the attempt.

The Claude backend declares the same cause for its own authentication failures
(`Not logged in`, HTTP 401/403), since a fix run by the same unauthenticated CLI
would fail identically. A step with `blocking: false` records a warning and lets
later steps continue, blocked or not.

Only an agent verdict and a backend result can declare a block: those are the two
boundaries that read the signal. A `fn` step that throws — including
`new Error("BLOCKED: …")` — and a `bash` step that exits non-zero are technical
failures, and go through the step's normal retry and `onFail` policy. Use `require`
to turn an environment precondition into a stop before anything is spawned.

## Failure policy shapes

```ts
llmStep({
  id: "checks",
  name: "Run checks",
  backend: "claude",
  profile: "reviewer",
  command: "run the checks and return a verdict",
  onFail: {
    fix: (ctx) => `Fix these errors:\n${ctx.errors}`,
    retries: 3,
  },
});
```

`onFail` takes one of three orthogonal shapes:

| Shape | Behavior |
|---|---|
| `{ retries }` | reruns the original command in a fresh session; no repair prompt |
| `{ fix, retries }` | repair in a fresh session, then rerun the original command, up to `retries` |
| `{ fix, resumeSession: "<stepId>", retries }` | repair by resuming the session recorded by the agent step `<stepId>`, then rerun, up to `retries` |

Whether `fix` is present decides whether there is a repair pass; the command is
**always** rerun and verified afterward, whichever shape is used — there is no
unverified repair mode. `retries` is required for a plain rerun. With `fix`, it
defaults to `1`, and `retries: 0` is refused: the loop would never run, and the
step would fail without ever attempting a repair. `resumeSession` without `fix`
is refused, and `{ retries, resumeSession }` alone is a type error.

A step that succeeds after a repair records it in its done reason: `(after N
fixes)` for a fresh-session repair, `(after N resumed fixes)` when
`resumeSession` was used.

The consumed quota is persisted on the step, so it is cumulative across run
segments: a step that spent its `retries` before an interruption and is
readmitted on resume (`rerunOnResume`) replays its command but gets no further
repair. The step log says so — `Fix quota already consumed (2/2 retries), no
repair launched` — and no `Fix backend …` line is printed, because that line is
emitted only when a repair actually starts.

### Resume an earlier step's session

`resumeSession` names the `id` of an `llmStep` declared earlier in the same
pipeline. Every agent step records its session; nothing has to be marked on the
target. The repair reopens that session (Claude `--resume`, opencode `--fork`)
with the fix prompt, and the resulting conversation is written back as the
target's session, so a later gate resuming the same step continues the repaired
conversation rather than the pre-fix one. The scope is the current run only: a
nested pipeline cannot resume a session of its parent.

Loading rules, each refused with a `step "X": resumeSession "T": …` error:

- `no step with this id`: `T` is not declared in the pipeline;
- `cannot resume its own session`: `T` is the step itself;
- `step "T" is not an agent step, it has no session`: `T` is a `bashStep` or
  `actionStep`;
- `step "T" runs after "X": its session does not exist yet`: `T` is declared
  after the resuming step.

At runtime the target can still have no usable session, for instance when a
`when` admission skipped it or when its provider reports a non-resumable
session. The repair then falls back to the default backend in a fresh session,
the step log states `⚠ step "T" has no session — starting a fresh session`, and
the run continues.

### Re-ask after a refused capture

A step with [`capture`](dsl.md#captured-outputs) can succeed and still fail: the
agent's verdict says success, but the object it returned is refused by the
artifact's parser — a field is absent, or two fields together break an invariant
the strict schema cannot express (`risk: "high"` with `testPolicy: "none"`). The
pipeline cannot answer this itself: `resumeSession` may not name the step's own
session, and every other `onFail` shape replays the command in a fresh session
without the reason of the refusal. The runner therefore asks once, on its own.

The re-ask resumes the step's session with a short message — that the output was
refused, and why — instead of the step command, so the work already done is not
redone; the backend re-declares the output schema as it does for any attempt.
It is a tracked attempt like a rerun: its own log (`--- re-ask 1/1 ---`), its
own line in the ledger, its own verdict. A corrected object completes the step
and writes the captured artifact; a second refusal fails the step with
`(output contract refused, no fix configured)`, and the `onFail` policy, if any,
takes over from there. The refused object is appended to the log of the attempt
that produced it.

The re-ask is bounded to one and is withheld when the step has no resumable
session, when the backend cannot resume, or when `costDecision` withholds work —
the same accounting stop a retry observes, recorded the same way. A re-ask that
hands back the very object that was refused is reported as such and not insisted
upon.

### Which backend repairs

An agent step (`llmStep`) is always repaired by its own backend, whatever the
policy. The repair also runs under the step's own `options` — a Codex `sandbox`,
`addDirs`, `codexProfile` — so a step that declared `sandbox: "workspace-write"`
gets a repair that can actually write its patch, and a step that declared nothing
gets Codex's `read-only` default. `backendOptions` on the policy replaces that
inheritance: it is the way to restrict the repair on purpose.

A `bashStep` has no backend, so the runner decides:

- **With `fix` alone**: the default backend, in a fresh session, unless the
  policy names another one with `fixBackend` (see below).
- **With `fix` and `resumeSession`**: the provider of the session recorded by
  the target step. A session cannot be injected into another provider, so a
  Codex-authored lot is repaired by Codex with its context intact even when
  Claude is the default backend. The default backend is used, in a fresh
  session, only when the target step has no session, when its provider is not
  registered, or when `fixProfile` has no policy for that provider; the reason
  is logged and the run continues.

The step log states the choice and its reason before the first repair
(`Fix backend codex — resumed session provider ("implement")`, or
`Fix backend claude — default backend (step "implement" has no session)`).

### Choose the repair backend of a bash step

`fixBackend` on a fresh-session policy replaces the default backend for the repair
of a `bashStep` or `actionStep`:

```ts
bashStep({
  id: "lint",
  name: "Lint",
  command: "npm run lint",
  onFail: { ...mechanicalFix((ctx) => `Fix the lint errors:\n${ctx.errors}`), fixBackend: "codex" },
});
```

`fixProfile` is then resolved on that backend at load time
(`profiles.<role>.backends.<fixBackend>`), and a role without a policy for it is
refused. Options shaped for another provider are dropped: the `claude` options of
`mechanicalFix` do not reach a Codex repair. Three combinations are refused at load
time: a backend that is not registered, an agent step (it is always repaired by its
own backend), and `resumeSession` (the repair must land on the resumed session's
provider). The step log reports `Fix backend codex — declared by the fix policy
(fresh fix session)`.

When the repair moves to the resumed session's provider, options materialized at load time
(`claude`, `fixProfile` axes) no longer apply: they were shaped for the default
backend. `fixProfile` is then re-read from `profiles.<role>.backends.<provider>`;
without it the repair starts from that provider's defaults. Declare `fixProfile`
on a resumed gate when the model and effort of the repair matter.

`escalate.model` is a provider-specific name. A `bashStep` with `resumeSession`
that declares one, when the target step runs on a non-default backend, is
refused at load time (`the repair resumes the session of "implement" on codex`):
the repair would resume on that backend and the model name would not apply. Drop
`escalate.model` there, or drop `resumeSession`. `escalate.effort` stays valid
on every backend.

Timeouts are drained with fresh reruns before a fix policy receives a truncated
output. This timeout-drain quota is separate from the normal `retries` quota. A
persistent timeout fails (or warns for a non-blocking step) without sending an
uninformative fix prompt.

### Repair only what the extractor could read

By default a failing step is repaired even when its `errorExtractor` returned
nothing: the raw output feeds the fix prompt, which is what a crash *after* the
report was written needs (see
[guide/extractors.md](extractors.md#reports-and-missing-reports)). The reverse
case is a step that never ran at all — a container that is down, a missing
binary, `make` stopping on an upstream target. The raw stderr then describes the
infrastructure, and a repair paid on it edits code no test ever exercised.

`fixOnlyWhenExtracted: true` opts out of the default for one step:

```ts
bashStep({
  id: "tests",
  name: "Tests",
  command: "docker compose exec -T php php bin/phpunit --log-junit var/junit.xml",
  report: "var/junit.xml",
  errorExtractor: "phpunit",
  onFail: {
    fix: (ctx) => `Fix the failing tests:\n${ctx.errors}`,
    retries: 2,
    fixOnlyWhenExtracted: true,
  },
});
```

When the extraction holds no actionable error, the step fails immediately: no
repair pass is spawned and no retry is consumed, so the quota is still whole for
a resume once the obstacle is lifted. The log names which of the two cases it
was, because they call for different actions:

- `phpunit: no report was produced — the command failed before the suite ran —
  failing without repair (fixOnlyWhenExtracted)`;
- `phpunit: the report holds no actionable error — failing without repair
  (fixOnlyWhenExtracted)`.

The option requires `errorExtractor` — without one there is no extraction to
read, and the declaration is refused at load time. A non-blocking step absorbs
the failure as usual. Omitting the option keeps the default behavior unchanged.

## Capacity escalation

`onFail.escalate` changes only the agent attempt configuration:

```ts
onFail: {
  retries: 4,
  escalate: {
    after: 2,
    effort: "high",
    model: "opus[1m]",
  },
}
```

For an ordinary failure, the next eligible retry first uses `effort`, then
`model`. `after` defaults to `2` and counts attempts already made before the next
retry. The ladder is sticky and never moves backwards. A wall-clock timeout skips
the effort rung and goes directly to `model`, because asking a timed-out attempt to
think harder is not useful. If only one rung is configured, the runner uses that
rung. If a backend cannot translate the requested axis, it cannot provide that
escalation.

The backend remains the one selected by `llmStep({ backend })`; escalation does not
switch providers. There is no automatic fallback between providers. The nominal model
and effort come from the provider-specific profile policy, for example:

```json
{
  "profiles": {
    "coder": {
      "backends": {
        "codex": { "model": "gpt-5.6-luna", "effort": "medium" },
        "claude": { "model": "opus", "effort": "medium" }
      }
    }
  }
}
```

The step must still explicitly select one of those backends and the profile must
define a policy for that backend. A profile entry for Claude does not authorize a
Codex step, and vice versa.

## Budgets and persistence

Every attempt, retry, fix, session, usage sample, and cost is persisted. A run
budget is checked before each spawn; resume includes cost already recorded by
previous attempts. When the budget is exhausted, remaining steps/retries are not
spawned and the run reports `BUDGET EXCEEDED`. A work-item loop uses
`maxCostPerWorkItemUsd`; a simple pipeline uses `maxCost`.

The same gate withholds retries and fix passes when a capped run's spend stops
being priceable: the run reports `COST UNACCOUNTED` instead, and the retry loop
logs which stop it hit rather than repairing its way past it. Uncertainty about a
price is not a technical failure, so no fix prompt is spawned for it and no
`onFail` policy can absorb it — including on a step declared `blocking: false`.
The failing step keeps the reason of its own last attempt, the pending steps stay
pending, and `--allow-unmetered` is what resumes the loop.

That gate needs a *measured* unaccounted spend. An attempt that failed without
reporting any figure at all — a timeout, a straggler kill, a signal, or a
transport break before the first message — keeps its `cost_unknown` marker so the
total stays a lower bound, but it does **not** withhold the retries the step
declared: they are the only way back to a priced attempt, and a run that denied
itself its own `retries: 3` over one transient transport failure would be frozen
by the very policy meant to recover from it. See
[What counts as unaccounted spend](budgets-timeouts.md#what-counts-as-unaccounted-spend)
and
[Unknown spend stops a capped run](budgets-timeouts.md#unknown-spend-stops-a-capped-run).

The run's state and event journal make retries resumable. See
[`persistence.md`](persistence.md) for file locations and
[`sessions-tracing.md`](sessions-tracing.md) for provider session identities.
