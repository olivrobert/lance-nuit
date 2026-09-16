# Human control: work-item escalation and approvals

This guide covers the second escalation path: handing a work item to a human. It
is deliberately separate from technical retry escalation. A capacity escalation
changes an agent's effort/model for another attempt; a human escalation publishes
a note, moves the ticket out of automation, and stops or gates the run.

## Escalate a work item

The project DSL exposes `workItemEscalateStep` and the unified `humanReview`. A
declaration that publishes a note must be inside a `forEachWorkItem` pipeline so
the source queue is known:

```ts
import type { Dsl } from "@lance-nuit/dsl";

export default ({ pipeline, artifact, humanReview }: Dsl) => {
  const triage = artifact("triage.json", (raw) => {
    if (!raw || typeof raw !== "object") throw new Error("invalid triage");
    const value = raw as { verdict?: unknown; reason?: unknown };
    if (value.verdict !== "proceed" && value.verdict !== "review") {
      throw new Error("invalid verdict");
    }
    return { verdict: value.verdict, reason: String(value.reason ?? "") };
  });

  return pipeline("feature")
    .forEachWorkItem({
      queue: "featureTodo",
      do: [humanReview({
        id: "triage-review",
        artifact: triage,
        kind: "needs-decision",
        blocked: (value) => value.verdict === "review",
        approval: { subject: "triage" },
        note: (value) => ({
          headline: "🤖 Escalation — the feature needs a human decision.",
          fields: [
            { label: "Reason", value: value.reason },
            { label: "State", value: "no code written" },
            { label: "Action", value: "clarify the ticket, then rerun the pipeline" },
          ],
        }),
        reason: (value) => value.reason,
      })],
    })
    .build();
};
```

`humanReview` expands to a non-blocking escalation step followed by a stop gate.
The artifact is read once for admission and note construction. A missing or
invalid artifact, or a false `blocked`, skips the escalation. Otherwise the runner
publishes a structured note and calls `moveTo({ queue: "escalate", from })`, where
`from` is inferred from the loop's `queue`. The gate then stops the run cleanly.
When `approval` is present, the note displays `lancenuit run <ticket> --pipeline
feature --approve triage`; `feature` comes from `pipeline("feature")`, so renaming
the pipeline does not require changing the review declaration. That single command
records the decision and resumes the run — only the `approve` subcommand (which
forces `--approve-only`) writes the decision without running anything.

## Gate a child pipeline

Omit `note` to declare an exit point in a pipeline that owns no work item — a child
run started by `runPipeline` or `forEachPipeline` borrows its parent's ticket, and
escalation needs a source queue that only the parent has. `humanReview` then builds
the stop gate alone: no note is published, the child run stops, its parent reports
the failure, and `--approve <subject>` still lifts the block. The subject is
declared by the gate as usual, so `lancenuit approve <ticket> <subject> --pipeline
<child>` resolves the artifact without running anything.

Two consequences to keep in mind when a child gate carries an approval:

- Decisions live in the work item, not in the run: `<work-item>/decisions/`. A
  child run using its parent's ticket therefore SHARES that directory with its
  parent and with its sibling runs. Give the child gate its own subject; reusing
  the parent's would overwrite the parent's decision file.
- The approval is locked to the artifact's SHA-256, so a sibling run that rewrites
  the same artifact invalidates the decision and reopens the gate. That is what
  keeps one approval from covering the next child run.

Use `workItemEscalateStep` alone when the pipeline should perform the tracker move
without adding a stop gate. The simple `escalation` callback requires non-empty
`cause`, `state`, and `action`; `details` is an object of strings. The alternative
`note` callback returns a provider-neutral `{ headline, fields, footer? }`. The two
forms are mutually exclusive.

This is not an automatic retry or a provider fallback. Rerun the pipeline after the
human has answered or supplied the missing material. A clean stop keeps the
remaining steps pending, so that rerun resumes the same run: the gate is
re-evaluated and the steps completed before the stop are not replayed. The tracker gateway excludes
pipeline-generated comments from the next `ticket.md`, so the human's answer is the
input that changes the next run.

"Answer and rerun" therefore holds on a resume, not only on a fresh run: a step
that declares `input` is re-admitted when the run is resumed, and it replays as
soon as one of its declared inputs no longer matches the fingerprints its outputs
were produced from. A step that declares nothing keeps the old behavior and stays
settled. See [`dsl.md`](dsl.md#input-freshness).

## Idempotence and tracker failures

An escalation's stable `id` is the `{ ticket, stepId }` idempotence key. Keep it
stable after the first run, and give distinct escalation effects distinct IDs. The
gateway recognizes the marker on a previously published note; moving labels/state
is also replay-safe operation by operation.

Work-item effects are intentionally `blocking(false)`: a tracker outage is recorded
as a warning in the step and run statistics while code execution can continue. The
note and move are both attempted, so a later rerun can complete whichever effect
failed. This warning behavior is different from a technical step failure.

The runner ships Jira (`acli`) and GitHub (`gh`) gateways. The pipeline uses
logical queues (`bugTodo`, `featureTodo`, `done`, `escalate`) and states (`todo`,
`inReview`); each adapter maps them to its provider vocabulary. There is no
silent fallback to another tracker.

## Hash-locked human approvals

### Declare and record an approval

An approval binds a human decision to one artifact:

```ts
const plan = textArtifact("plan.md", (value) => {
  if (value.trim() === "") throw new Error("empty plan");
  return value;
});

const delivery = pipeline("delivery").approval("plan", plan);
// Add the pipeline's approval gate after this declaration, then call `.build()`.
```

The CLI resolves the static subject-to-artifact declaration without executing the
pipeline:

```bash
lancenuit approve PROJ-28 plan --pipeline delivery
lancenuit run PROJ-28 --pipeline delivery
```

`lancenuit approve` validates the artifact with its descriptor, computes SHA-256,
and writes `decisions/plan.json`. Changing the artifact invalidates the decision;
the gate stops again. Subjects use only `A-Z`, `a-z`, digits, underscore, and `-`.
The subject must be declared by the selected pipeline, and approval always names
that pipeline with `--pipeline`.

### Who approved

A decision records its author in `decidedBy`. It is `"human"` when nothing else
is known, and the value of `LANCENUIT_ACTOR` when the caller announces on whose
behalf it invokes the runner:

```bash
LANCENUIT_ACTOR="Olivier" lancenuit approve PROJ-28 plan --pipeline delivery
```

The name is bounded to 64 characters of letters, digits, spaces, dots, and
dashes; anything else is ignored and the decision falls back to `"human"`. The
name is a label, not a credential: it says who to ask about a decision, and it
grants nothing. Gates accept any non-empty author, so an approval signed by a
person opens the gate exactly like an anonymous one, and decision files written
before this field carried a name stay valid.

Project helpers can build richer gates that add an escalation note, branch
cleanup, or a resume command. Those policies use the same hash-locked decision
primitive; they do not change the distinction between human control and capacity
escalation. The package's current `default` pipeline declares no approval subject.
