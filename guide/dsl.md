# DSL

## Create a project pipeline

A project pipeline lives in `.lance-nuit/pipelines/<name>.ts` and exports a factory.
The runner injects the authoring DSL at load time; context remains available in step
callbacks without a runtime import from the plugin.

A pipeline shared by MULTIPLE projects lives in `~/.lance-nuit/pipelines/<name>.ts`:
same DSL, same layout, resolved through the chain described above.

The `src/project/dsl-types/install.ts` installer generates declarations in `<kit>/.lance-nuit-types/`
and an alias in `<kit>/tsconfig.json`. The runner thus installs a local types package named
`@lance-nuit/dsl`; the only `import type` below is used for completion and
typechecking, then disappears entirely at runtime.

To create a minimal pipeline and automatically install types and typecheck it:

```bash
lancenuit create quick-check --command "make test"           # → .lance-nuit/pipelines/
lancenuit create deploy --command "make deploy" --user       # → ~/.lance-nuit/pipelines/
```

The name must match `^[a-z][a-z0-9-]*$`. The target is `<kit>/pipelines/<name>.ts`,
and an existing file is never overwritten. If typechecking fails after creation,
the file is kept and the runner explicitly reports “created but typecheck failed”.

`--template <id>` renders a starting point other than the single shell step:
`bash` (default), `checked`, `agent`, `review`, and `work-item`. A template that
runs a project command requires `--command`; the others reject it. Run
`lancenuit help` for the current list, and read the rendered file: each one is a
commented, typechecked example of the capability it demonstrates.

```bash
lancenuit create audit --template review --command "make test"
lancenuit create triage --template work-item
```

Pipelines import their types from `@lance-nuit/dsl`. It is not an npm package:
it is a path alias that `lancenuit create` wires into the generated
`.lance-nuit/tsconfig.json`, pointing at declarations installed inside your
project. Only type-level imports are valid through it; runtime values always
come from the injected factory argument.

<!-- project-pipeline-example:start -->
```ts
import type { Dsl } from "@lance-nuit/dsl";

type Triage = {
  verdict: "proceed" | "review";
  reason: string;
};

function parseTriage(value: unknown): Triage {
  if (!value || typeof value !== "object") throw new Error("invalid triage");
  const raw = value as { verdict?: unknown; reason?: unknown };
  if (raw.verdict !== "proceed" && raw.verdict !== "review") {
    throw new Error("invalid triage verdict");
  }
  if (typeof raw.reason !== "string") throw new Error("missing triage reason");
  return { verdict: raw.verdict, reason: raw.reason };
}

export default (
  {
    pipeline,
    llmStep,
    artifact,
    promptFile,
    workItemEscalateStep,
  }: Dsl,
) => {
  const triage = artifact("triage.json", parseTriage);
  const triagePrompt = promptFile(
    "./prompts/triage.md",
    ["ticket", "artifactsDir"] as const,
  );

  return pipeline("project-feature")
    .desc("Triage a feature before development")
    .forEachWorkItem({
      queue: "featureTodo",
      scan: { limit: 3 },
      maxCostPerWorkItemUsd: 5,
      do: [
        llmStep({
          id: "triage",
          name: "Triage",
          backend: "claude",
          profile: "triage",
          command: (ctx) =>
            triagePrompt({
              ticket: ctx.ticket ?? "unknown",
              artifactsDir: ctx.paths.artifactsDir ?? "artifacts",
            }),
          output: [triage],
        }),
        workItemEscalateStep({
          id: "review-triage",
          artifact: triage,
          onlyIf: (value) => value.verdict === "review",
          escalation: (value) => ({
            cause: "the feature requires a human decision",
            details: { Reason: value.reason },
            state: "no code written",
            action: "decide on the ticket, then return it to the queue",
          }),
        }),
      ],
    })
    .build();
};
```
<!-- project-pipeline-example:end -->

The `.lance-nuit/pipelines/prompts/triage.md` prompt uses the declared placeholders:

```md
Analyze ticket {{ticket}} and write triage.json to {{artifactsDir}}.
```

Conventions for every new project pipeline:

- a factory receiving `Dsl`, never a runtime import from `@lance-nuit/dsl`;
- `llmStep({ backend: "claude" | "codex" | "opencode", ... })` for every new agent step;
- `when` for admission, `require` for the environment guard, and `output` for
  expected artifacts;
- `forEachWorkItem({ queue, scan, do })` to make repeated scope explicit;
- `promptFile()` for long prompts;
- `lancenuit typecheck` before the run.

## Work-item escalation in a project pipeline

This is the **human/work-item escalation** path: it publishes a structured note,
moves the ticket to the logical `escalate` queue, and (with
`humanReview`) stops the run until a human has supplied the missing
decision. It is unrelated to retry escalation, which changes an agent's effort
or model after a technical failure. See
[`human-control.md`](human-control.md) for the full workflow and
[`failures-retries-escalation.md`](failures-retries-escalation.md) for technical
retry escalation.

The injected DSL exposes `forEachWorkItem`, `workItemEscalateStep`, and the unified
`humanReview` helper. The loop
declares its logical queue with `queue`, independently of scan mode, so escalation
infers `from` automatically. A loop without an identifiable queue is rejected while
building the pipeline.

Minimal example:

```ts
import type { Dsl } from "@lance-nuit/dsl";

export default ({ pipeline, artifact, workItemEscalateStep }: Dsl) => {
  const triageArtifact = artifact("triage.json", (value) => value as { verdict: string });

  return pipeline("my-feature")
    .forEachWorkItem({
      queue: "featureTodo",
      do: [workItemEscalateStep({
        id: "escalate-triage",
        artifact: triageArtifact,
        escalation: () => ({
          cause: "ticket is not eligible",
          state: "no code written",
          action: "complete the specification",
        }),
      })],
    })
    .build();
};
```

Artifact-based example: `artifact` is validated and read once; the same typed value
is passed to `onlyIf` and `escalation`. A missing or invalid artifact, or a false
`onlyIf`, produces a skip.

```ts
export default ({ pipeline, artifact, workItemEscalateStep }: Dsl) => {
  const triageArtifact = artifact("triage.json", (value) => {
    if (!value || typeof value !== "object") throw new Error("invalid triage");
    return value as { verdict: "escalate" | "proceed"; reason: string };
  });

  return pipeline("my-feature")
    .forEachWorkItem({
      queue: "featureTodo",
      do: [workItemEscalateStep({
        id: "escalate-triage",
        artifact: triageArtifact,
        onlyIf: (triage) => triage.verdict === "escalate",
        escalation: (triage) => ({
          cause: "ticket is not eligible for auto-development",
          details: { Reason: triage.reason },
          state: "no code written",
          action: "complete the ticket specification",
        }),
      })],
    })
    .build();
};
```

The advanced `note` form directly supplies a `WorkItemNote` when the standard format
is not enough:

```ts
workItemEscalateStep({
  id: "escalate-custom",
  artifact: triageArtifact,
  note: (triage) => ({
    headline: "Specialized escalation",
    fields: [{ label: "Reason", value: triage.reason }],
    footer: "A human decision is required.",
  }),
});
```

`escalation` and `note` are mutually exclusive, and one is required. In the simple
form, `cause`, `state`, and `action` are required as well. Finally, `id` is the
`{ ticket, stepId }` idempotence key: it must remain stable after first use; distinct
escalations must have distinct IDs.

## Choose the agent backend

For every new project pipeline, set `backend` on `llmStep({...})`. The pipeline then
uses only the shared contract: prompt, JSON verdict, usage, cost, session, and
resume. `BackendFor<Profile>` rejects combinations absent from the installed project
configuration during typechecking.

```ts
import type { Dsl } from "@lance-nuit/dsl";

export default ({ pipeline, llmStep }: Dsl) =>
  pipeline("codex-implementation")
    .add(llmStep({
      id: "implement",
      name: "Implement",
      backend: "codex",
      profile: "coder",
      options: { sandbox: "workspace-write" },
      command: "Implement the task and return the expected verdict",
    }))
    .build();
```

`backend` selects the provider directly and `options` carries only that provider's
technical options. There is no automatic fallback from one backend to another: if
the selected backend is unavailable or its profile policy is missing, validation or
execution fails. `withBackend(id, options)` is the low-level authoring escape hatch
for a backend already registered in the runner; registering a new provider also
requires a registry/backend implementation.

The Codex backend uses `codex exec --json` and reports JSONL events, tokens (`input`,
cache, output, reasoning), the thread, and tools. Its sandbox is explicitly
`read-only` by default; a step that modifies the worktree must request
`sandbox: "workspace-write"`. Profile axes are provider-specific:
`profiles.<role>.backends.codex` is the profile-level form that configures the
Codex model and effort. Step overrides and capability frontmatter can refine that
policy later. A missing policy for the selected backend is rejected before
execution.

The opencode backend uses `opencode run --format json` and reaches the whole
provider catalogue through one adapter, with cost reported per step by the
provider. It has no sandbox option: the runner picks a tool-restricted agent from
the step's role, and writes its own `opencode.json` rather than inheriting the
user's. Details in
[Agents, profiles, and backends](agents-profiles-backends.md#opencode-specifics).

## API reference

[`docs/DSL-API.md`](../docs/DSL-API.md) is generated from the TypeScript declarations
installed by `bun run docs:dsl`. It contains factory signatures, closed options, and
context types. The structural primitives are:

- `pipeline(name)` to assemble steps and work-item scope;
- `llmStep({ ... })`, `bashStep({ ... })`, and `actionStep({ ... })` for the three
  execution modes;
- `workItemEscalateStep`, `humanReview`, and `workItemDeliveryStep` for
  business transitions;
- `runPipeline({ id, name, pipeline, ticket?, when? })` for one child;
- `forEachPipeline({ id, name, items, pipeline, when?, afterEach?, afterAll? })`
  for a sequential child loop;
- `artifact(name, parser)` / `textArtifact(name, parser?)` for artifact descriptors,
  and `.approval(subject, artifact)` for approvable subjects;
- `llmStep({ capture: { field: artifact | { artifact, schema } } })` to have the
  runner persist a field of the agent's verdict as an artifact — see
  [Captured outputs](#captured-outputs).

The `--scan` capability is provided by `forEachWorkItem({ scan: { limit?, query? }, ... })`.
Declare the queue with `queue: "bugTodo" | "featureTodo"`. By default discovery
selects the tickets carrying the queue label in the todo state. `scan.query`
replaces that selection with a provider-native query the pipeline owns entirely
(for Jira a complete JQL, project clause included; for GitHub the `gh issue list
--search` syntax): the runner passes it verbatim and completes nothing, so any
filter the tracker understands — assignee, sprint, component — is available.
Delivery moves (`done`/`escalate` labels, review state) are unchanged. `dir` is optional and
falls back to `context.paths.artifactsDir` at execution time. `before` entries are
replayed for each ticket before loading it (capability preflight, for example).
Closed tickets are rejected by default; `load: { allowClosed: true, retries: 1 }`
explicitly allows them and/or retries a transiently failed read.

## Pipeline composition

`runPipeline` and `forEachPipeline` create orchestration nodes, never shell
commands. Each call has its own `state.json`, `runId`, and events; the parent
snapshot keeps each child's link, status, and `accountedCostUsd`. A loop is
sequential, stops at the first failure, runs `afterEach` after the corresponding
child, and runs `afterAll` only when the entire loop succeeds.

These functions are DSL-injected helpers (`({ runPipeline, forEachPipeline }) => ...`)
and are used directly in `.add(...)` or `do`, without an initial entry point. Children
inherit the cwd/worktree already accepted by the parent and do not repeat the
top-level clean Git tree guard.

A pipeline name follows CLI resolution (project pipeline, then builtin). An
explicit path is resolved relative to the calling pipeline file. On resume, the
item list and children already linked to the node are reused: the runner resumes the
first incomplete call and credits only the cost difference since the last accounting.
`parentRunId`, `parentNodeId`, `rootRunId`, and `budgetScopeId` make this hierarchy
observable.

## Admission, environment, and failure

`when` composes admissions in declaration order; the first `skip`, `fail`, or `stop`
outcome ends admission. `require` is an environment guard evaluated next and before
any spawn. `output` is proof of completion, while `onFail` groups repair, retries,
and escalation in one editor-discoverable value.

Four admission forms are accepted individually or in a list:

| Form | Meaning |
|---|---|
| `when: predicate` | runs if true; otherwise `skip` — shorthand for `{ if: predicate }` |
| `when: { if: predicate, else? }` | runs if true; otherwise `skip` (default), `fail`, or `stop` |
| `when: { unless: predicate, else? }` | does NOT run if true — the predicate expresses the reason not to run |
| `when: { command, else? }` | same in Bash: non-zero exit means the `else` outcome |

`if` and `unless` are not redundant: a named predicate naturally expresses either
the entry condition (`hasRunStats`) or the exit reason (`refactorAlreadyApplied`).
Forcing it the other way creates a double negative that costs clarity on every read.

Admission is reevaluated on every resume, including for an already-attempted step,
except for `runPipeline`/`forEachPipeline` **that has already created a child**: its
composition decision is frozen by the snapshot, otherwise a resume could make an
already-declared call disappear. Other guards on the same step are replayed.

### Input freshness

`input` declares the artifacts a step reads, symmetrically to `output`. It is the
answer to "the human answered on the ticket, rerun": the runner replays the steps
whose sources moved, and only those.

```ts
bashStep({
  id: "spec",
  name: "Spec",
  command: "write-spec",
  input: [ticket],
  output: [spec],
})
```

The rules:

- **Opt-in.** Only a step declaring `input` changes behavior. A step declaring
  `input` without `output` is rejected at build time: freshness is decided on the
  outputs.
- **Pure inputs** are `input` minus `output`. An artifact listed in both is
  **revised in place**: it is not erased before the attempt, it is not part of the
  fingerprint, and it is still required afterwards.
- **Fingerprint.** SHA-256 of the raw bytes of every pure input, read at the start
  of the attempt and recorded on success, after the outputs are verified, in one
  provenance record per produced artifact.
- **Freshness of an output** at admission time: absent is `missing`; a pure input
  absent is `unknown` (a safe bias); no record, or a declared input with no
  recorded fingerprint, is `adoptable`; a fingerprint that differs is `stale`;
  otherwise `fresh`.
- **Decision.** The step runs when an output is `missing`, `unknown`, or `stale`.
  Otherwise it is skipped with `outputs up to date with declared inputs`.
- **Adoption.** An output that exists without a usable record adopts the inputs
  present now and is skipped. Without this, the feature would regenerate the
  deliverables of every work item already waiting for a human decision.
- **Order.** `when` first, freshness second. When `when` refuses while an output
  is stale, the reason reads `... (inputs changed, outputs kept)`.
- **Resume.** A `done` step declaring `input` is re-admitted, and so is a
  `skipped` one — unless it was taken out by `--step`, `--skip`, or `--start-at`.
  A re-admitted step whose outputs are all fresh costs nothing.
- **Provenance is merged, not replaced.** A step that revises an artifact updates
  its record, so `plan-audit` (`input: [spec, plan]`, `output: [planAudit, plan]`)
  does not break the provenance of `plan`.

A step declaring `input` should drop any "skip when the deliverable exists" guard
of its own: `when` is evaluated first, so such a guard would refuse the step
before freshness is ever consulted.

`freshness(ctx, artifact)` exposes the same records to a pipeline, returning
`fresh`, `stale`, `missing`, or `unknown` for one artifact against its own record.
It is what an author branches on to run an amendment step rather than a full
regeneration.

Known limits: writes that no `output` declares are not tracked; a `PASS` run is
never resumed, so a new run starts with everything `pending` (freshness still
applies); a `PASS` child pipeline is not re-entered; and a `when` with `stop`
re-evaluated on resume can stop on a step that already completed.

### Failure handling and retry escalation

`onFail` selects a retry/fix policy: a plain rerun (`{ retries }`), a fresh-session
repair (`{ fix, retries }`), or a repair that resumes the session of an earlier
agent step (`{ fix, resumeSession: "<stepId>", retries }`). `onFail.escalate` is the **technical
capacity escalation** mechanism: after the configured retry threshold it can raise
effort, then change model; a wall-clock timeout can go directly to the model rung.
The ladder is sticky for that failure loop and never falls back to a weaker rung.
It does not move a ticket or ask a human to decide. See
[`failures-retries-escalation.md`](failures-retries-escalation.md).

For a fresh, isolated repair restricted to Claude's `Read` and `Edit` tools, use
the `mechanicalFix(prompt)` policy injected with the rest of the DSL. It selects
`fix` with two attempts, high-effort escalation, and the `coder` fix profile as
one coherent policy:

```ts
export default ({ pipeline, bashStep, mechanicalFix }: Dsl) =>
  pipeline("checked")
    .add(bashStep({
      id: "check",
      name: "Check",
      command: "npm test",
      onFail: mechanicalFix((ctx) => `Fix these errors:\n\n${ctx.errors}`),
    }))
    .build();
```

A `bashStep` has no backend of its own, so its repair runs on the default backend.
Add `fixBackend` to the policy to repair on another provider in a fresh session
(`onFail: { ...mechanicalFix(prompt), fixBackend: "codex" }`); see
[which backend repairs](failures-retries-escalation.md#which-backend-repairs).

Provider-specific options live in `options`. Nominal `model` and `effort` come from
`profiles.<role>.backends.<backend>` (or a project override), not from step options.
The JSON verdict (`success`, `reason?`) is implicit for every agent step.

## Public surface

A project pipeline is always a default-exported factory. It receives the injected DSL
and execution context, then builds its object at load time:

```ts
import type { Dsl } from "@lance-nuit/dsl";

export default ({ pipeline, llmStep }: Dsl) =>
  pipeline("project")
    .add(llmStep({
      id: "review",
      name: "Review",
      backend: "claude",
      profile: "reviewer",
      command: (ctx) => `review ${ctx.ticket ?? "?"}`,
    }))
    .build();
```

The loader does not accept a directly-built object or a named pipeline export.
Built-in agent steps use `llmStep({ backend, ... })`, and admission uses `when`.

## Input conditions and artifacts

`artifact(name, parser)` binds an artifact's identity and validation once. Its
descriptor exposes `read(ctx)`, `require(ctx)`, `write(ctx, value)`, `remove(ctx)`,
and `validate(raw)`, and is used directly by `output` and `requireArtifact()`.

`validate(raw)` judges the file's **bytes** rather than an already-parsed value and
returns the typed value. This lets an external mechanism—the human approval below—
bind a decision to the exact approved content without duplicating artifact shape.

`textArtifact(name, parser?)` covers non-JSON artifacts, such as an agent-written
Markdown proposal. The parser receives bytes as-is; by default it returns them
unchanged, with “non-empty” as the only useful rule, already enforced upstream.
`write()` does not re-encode them: read bytes are exactly the bytes written.

`write()` validates the value with **the descriptor's parser** before writing: an
artifact its own read would reject fails here, not three steps later. This makes the
deterministic guard expressible—an `actionStep` reads an agent verdict, normalizes it,
and republishes it.

### Captured outputs

`output` alone asks the agent to **write the file itself**. That is the right tool for
a large document a skill produces with its own tools (`spec.md`, `plan.md`), and the
wrong one for a short value: each backend writes files its own way (Codex reaches
for `apply_patch` and fails on a one-line file), and a toolless role — `extractor`
on opencode — cannot write at all. `capture` inverts the contract: the agent
**returns** the value in its verdict object, and the runner writes the artifact.

```ts
const commitMessage = textArtifact("commit-message.md");
const branch = artifact("branch.json", parseBranch);

llmStep({
  id: "commit-message",
  name: "Commit message",
  profile: "extractor",
  backend: "codex",
  command: (ctx) => `Write a conventional commit message for ${ctx.ticket}`,
  // Short form: a text artifact, the field is a string.
  capture: { commit: commitMessage },
});

llmStep({
  id: "branch-name",
  name: "Branch name",
  profile: "extractor",
  backend: "claude",
  command: "Propose a branch name",
  // Long form: any artifact, with the JSON schema of the field. Mandatory for a
  // JSON artifact; the schema must be strict-mode compatible (see below).
  capture: {
    branch: {
      artifact: branch,
      schema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
});
```

The rules, all checked when the step is built:

- `capture` exists on `llmStep` only: a bash or action step has no structured
  output to read from. A raw definition that carries `captures` on another runner
  is rejected by validation.
- Field names are the keys of the verdict object. `success`, `reason`, and `blocked`
  are the verdict's own and are refused, as are a field or an artifact captured
  twice. Validation repeats these checks on a raw definition, which bypasses the
  builder: a capture named `success` would otherwise overwrite the verdict's own
  field in the schema sent to the provider.
- Every captured artifact joins `output` (once, if it is already listed), so it
  inherits everything an output has: erased before the spawn, proven by `require`
  after it, fingerprinted for [input freshness](#input-freshness), and listed in the
  `OUTPUTS` column of `lancenuit lint-pipeline`.
- The short form is reserved to `textArtifact`. A JSON `artifact` needs the long
  form with a `schema`, and that schema must be **strict-mode compatible**: on every
  object node, `required` lists exactly the declared `properties` and
  `additionalProperties` is `false`. The providers' structured-output modes reject
  anything else with a 400 at spawn time, which is why the DSL refuses it at build
  time instead. Express optionality with a `null` union (`type: ["string", "null"]`),
  never by omitting a name from `required`. The schema is limited to `type`,
  `properties`, `required`, `additionalProperties`, `items`, `enum`, and
  `description`: combinators (`anyOf`, `oneOf`, `allOf`, `not`, `if`/`then`/`else`),
  references (`$ref`, `$defs`, `definitions`), and `patternProperties` are refused,
  because the DSL cannot check what they hide and would let the 400 through.

At run time, once the attempt succeeds and before `require` verifies the outputs,
the runner reads each field from the verdict object and calls `artifact.write(ctx,
value)`. The artifact's own parser therefore validates the value, exactly as an
`actionStep` guard would. A field that is absent or `null`, a non-string value for
the short form, or a value the parser refuses fails the attempt with an explicit
reason (`capture "commit": absent from the agent's structured output`), the same
way a missing `require` does — the fix policy of the step then applies. Every
capture is validated before any is written: when one is refused, none lands on
disk, so a fix pass (which erases no output) never sees an artifact left by the
failed attempt. The refused object itself is appended to the attempt's step log
under a `--- capture refused: <reason> ---` separator: the structured output
travels through a tool call the live log never shows, so this entry is its only
trace.

A refusal is also the one failure the runner answers on its own. Because the
schema cannot carry a constraint between two fields, an invariant such as "a high
risk requires a test policy" can only live in the artifact's parser — and the
pipeline cannot ask the agent to correct it, since `onFail` may not resume the
step's own session. The runner therefore asks the same session once for a
corrected object; see
[Re-ask after a refused capture](failures-retries-escalation.md#re-ask-after-a-refused-capture).

How the field reaches the agent depends on the backend, the runner hides the
difference:

| Backend  | Channel                                                                   |
|----------|---------------------------------------------------------------------------|
| codex    | Added to the `--output-schema` file, next to `success`/`reason`/`blocked` |
| claude   | Added to `--json-schema`; in `RUNNER_VERDICT_MODE=text`, named in the text instruction |
| opencode | Named, with its schema, in the prompt-injected verdict instruction, and read back from the ```` ```json:verdict ```` block |

Without `capture`, the verdict schema and instruction are exactly what they always
were. Both modes coexist on one step: a skill can write `spec.md` through `output`
while the same step captures a one-line summary through `capture`.

`when` handles admission for a step written with its factory. Helpers retain their
specific use: `requireArtifact(descriptor, skip() | fail() | stop())` as a `when`
value, and `skipIf`, `failIf`, `stopIf`, `skipUnless`, `failUnless`, `stopUnless`,
`skipUnlessCommand`, `failUnlessCommand`, and `stopUnlessCommand` to condition an
already-built step. Conditions are ordinary DSL values and work equally with
`bashStep`, `llmStep`, and `actionStep`.

```ts
const triage = artifact("triage.json", parseTriageArtifact);

const producer = llmStep({
  id: "triage",
  name: "Triage",
  profile: "triage",
  backend: "claude",
  command: "produce triage.json",
  output: [triage],
});
const consumerAdmission = requireArtifact(triage, fail());
const value = await triage.require(ctx);

// Deterministic guard: normalize and republish an agent verdict.
actionStep({
  id: "triage-guard",
  name: "Triage guard",
  describe: "normalize triage.json",
  when: consumerAdmission,
  run: async (ctx) => {
    const guarded = applyGuard(await triage.require(ctx));
    await triage.write(ctx, guarded);
    return `verdict=${guarded.verdict}`;
  },
});

// An async command reads the artifact instead of parsing it again in the shell.
bashStep({
  id: "replay",
  name: "Replay the red test",
  command: async (ctx) => `npm test -- ${(await redtest.require(ctx)).testFile}`,
});
```

### Human approvals

A pipeline can require a human to review an artifact before continuing. Declare the
approval subject on the builder with the artifact it commits to:

```ts
const budget = artifact("budget.json", parseBudget);

export default ({ pipeline, actionStep }: Dsl) =>
  pipeline("budgeted")
    .approval("budget", budget)
    .add(/* … */)
    .build();
```

The human approves with `lancenuit approve <ticket> budget --pipeline budgeted`. The
runner validates `budget.json` **with the descriptor's parser**, computes its SHA-256,
and writes `decisions/budget.json`. Modifying the artifact afterward expires the
decision: the hash no longer matches and the gate closes again.

The subject is a free-form string (charset `[^\\w-]`, it becomes a filename). There is
no closed list: `review`, `assumptions`, and `refactoring` are declared exactly
like any other project subject.

`.approval()` declares **what is approvable through this pipeline**, not where the gate
lives. The two are intentionally separate:

- the CLI must resolve the `subject → artifact` mapping **without executing** the
  pipeline, so the declaration must be static;
- the gate retains its escalation messages, which a generic helper could not produce
  (child-work-item count, proposal path, ...).

Read the gate with the injected `decisionMatchesArtifact(ctx, subject, artifact)`
and `reject` helpers, typically in a `when` that `stop`s while the decision is
missing:

```ts
actionStep({
  id: "budget-gate",
  name: "Wait for budget approval",
  describe: "budget approval gate",
  when: {
    if: async (ctx) => await decisionMatchesArtifact(ctx, "budget", budget)
      ? true
      : reject(`pending: lancenuit approve ${ctx.ticket} budget --pipeline budgeted`),
    else: "stop",
  },
  run: async () => "budget approved",
});
```

Two safeguards run while loading the pipeline, not during a run: a subject outside
the charset and one subject declared on two different artifacts.

A subject not declared by the target pipeline is rejected with the list of declared
subjects. Consequently, `--approve` requires `--pipeline`: the pipeline declaration
owns the mapping and must be loadable for approval to succeed.

### Profile, capability frontmatter, and attribution

Every agent step carries a profile. It is the deterministic nominal policy and the
cost-attribution key. A capability's frontmatter may impose provider axes such as
`model` or `effort`; when it does, that capability wins for the imposed axis and a
step escalation cannot override it. Leave an axis out of frontmatter when the
pipeline must vary it during retries:

```ts
llmStep({
  id: "implement",
  name: "Implement plan",
  backend: "claude",
  profile: "coder",
  command: "implement the plan",
  onFail: {
    fix: (ctx) => `fix: ${ctx.errors}`,
    retries: 4,
    escalate: { model: "opus[1m]", after: 2 },
  },
});
```

Nominal model and effort are never configured at the use site: they belong to the
profile's provider-specific policy. `bareStep` (where provided by a capability) is
an environment preset, orthogonal to the role. Profiles are not a provider
fallback map: the selected backend must have an explicit policy.

The verdict is read from `result.structured_output`. It falls back to the old
block ```` ```json:verdict ```` in the text when absent, so skills that still write it
remain valid. `RUNNER_VERDICT_MODE=text` switches entirely to the old path (an
instruction in the prompt), useful when the installed `claude` does not know
`--json-schema`.

Its shape is `{"success": true|false, "reason": "...", "blocked": true|false}`.
`success` is required, `reason` is free prose, and `blocked` says the step hit an
obstacle outside the code, so the run stops instead of attempting a repair that
cannot work. A `reason` starting with `BLOCKED:` says the same thing in prose
and is accepted too — see
[failures, retries, escalation](failures-retries-escalation.md).

A step with [`capture`](#captured-outputs) extends that object with one key per
captured field (`{"success": true, "reason": "...", "blocked": null, "commit": "feat: ..."}`).
The schema the runner sends keeps the strict-mode invariant whatever is added:
`required` is derived from `properties`, and `additionalProperties` stays `false`.
The verdict itself is still read from `success`/`reason`/`blocked` alone; the extra
keys are read once, by the runner, to write the artifacts.

## `PipelineContext` and `FixContext`

`PipelineContext` is passed to `command` functions, admissions, and actions;
`FixContext` extends it and is passed to `onFail.fix` functions.

**The field list lives in [`docs/DSL-API.md`](../docs/DSL-API.md), the “Context”
section—not here.** This guide used to carry a partial copy, which is worse than no
table: it looks exhaustive and makes readers conclude that an omitted field does not
exist. The least obvious entry points are:

- `ctx.config` — normalized project configuration, `sensitivePaths`,
  `usTokenBudget`, ... (the “Configuration readable from context” section);
- `ctx.paths.artifactsDir` — where `ticket.md` and business artifacts land, and
  `ctx.paths.artifact(name)` to resolve one;
- `ctx.artifacts` — logical access to ticket or child-work-item artifacts;
- `ctx.workItem` — tracker gateway (lazy resolution).

For a complete example, see
[`examples/builtin-reviews`](../examples/builtin-reviews/README.md), which shows
a full set of review entries authored as regular TypeScript steps.
