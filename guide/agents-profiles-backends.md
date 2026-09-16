# Agents, profiles, and backends

An agent step has two deliberately separate choices:

- `backend` selects the provider that executes it (`claude`, `codex`, or
  `opencode` in the built-in registry).
- `profile` selects the semantic role (`coder`, `planner`, `reviewer`, etc.).

The role supplies the provider-specific model and effort policy. Provider
options such as sandbox, tools, or permission mode stay on the step. This keeps
the pipeline readable and prevents a Claude model setting from being passed to
Codex by mistake.

## Declare a backend explicitly

Every `llmStep` requires a backend, profile, and exactly one `command` or
`prompt`:

```ts
import type { Dsl } from "@lance-nuit/dsl";

export default ({ pipeline, llmStep }: Dsl) =>
  pipeline("implementation")
    .add(
      llmStep({
        id: "implement",
        name: "Implement the change",
        backend: "codex",
        profile: "coder",
        options: { sandbox: "workspace-write" },
        command: "Implement the task and return the JSON verdict",
      }),
    )
    .build();
```

The runner's built-in backends are:

| Backend | Typical options | Notes |
|---|---|---|
| `claude` | `agent`, `systemPrompt`, `tools`, `allowedTools`, `strictMcp`, `settingSources`, `permissionMode` | Model and effort come from the profile. |
| `codex` | `sandbox`, `codexProfile`, `ephemeral`, `ignoreUserConfig`, `ignoreRules`, `skipGitRepoCheck`, `addDirs` | The default sandbox is read-only; request `workspace-write` to modify the worktree. |
| `opencode` | `agent`, `pure`, `fork`, `logLevel`, `firstEventTimeoutMs`, `disableClaudeCodeCompat` | Requires opencode 1.17.7 or later. No sandbox option: permissions come from the agent, which the role picks. See [opencode specifics](#opencode-specifics). |

The corresponding CLI must be installed and authenticated in the environment.
The backend contract standardizes structured verdicts, sessions, usage, costs,
and resume. Adding another provider requires an `AgentBackend` registry entry;
`withBackend(id, options)` is the low-level selector for an already registered
provider.

The registry is attached by boot and travels with the pipeline context; nothing
falls back to the built-in registry. Every step, fix loop, and spawn reads the
registry carried by its context, so a run composed with a custom registry uses
it everywhere. A context without a registry fails loudly at the first agent step
instead of silently resolving a built-in backend.

## Built-in roles

The runner provides these closed profile names:
`coder`, `planner`, `reviewer`, `relay`, `triage`, `operator`, and `extractor`.
Their nominal policies are:

| Profile | Claude | Codex | opencode |
|---|---|---|---|
| `coder` | `opus`, medium | `gpt-5.6-luna`, medium | — |
| `planner` | `opus`, medium | — | — |
| `reviewer` | `opus`, medium | `gpt-5.6-luna`, high | — |
| `relay` | `sonnet`, low | — | — |
| `triage` | `opus`, high | — | `opencode/nemotron-3-ultra-free`, medium |
| `operator` | `sonnet`, low | — | — |
| `extractor` | `haiku`, low | `gpt-5.6-luna`, low | `opencode/nemotron-3-ultra-free`, medium |

A dash means the role has no policy for that provider. Codex is declared on the
three roles a second backend is actually used for — `coder`, `reviewer` (at
`high`: a gate that wrongly passes lets false code through) and `extractor` —
and opencode only on the two text-to-JSON roles (`triage`, `extractor`), where a
wrong answer costs a retry rather than a bad edit. To use another role with a
provider it has no policy for, add that role's `backends.<backend>` policy in
project configuration; otherwise loading the pipeline fails before execution.

## Configure a role per backend

In `.lance-nuit/config.json`, configure only the provider you want to retune:

```json
{
  "profiles": {
    "coder": {
      "backends": {
        "claude": { "model": "opus[1m]", "effort": "high" },
        "codex": { "model": "gpt-5.6-luna", "effort": "medium" }
      }
    },
    "reviewer": {
      "backends": {
        "claude": { "model": "sonnet", "effort": "medium" }
      }
    }
  }
}
```

Supported effort values are `low`, `medium`, `high`, `xhigh`, and `max`.
`profiles.<role>.model` and `.effort` are invalid; the provider must always be
named under `profiles.<role>.backends.<backend>`. Unknown roles, axes, or effort
values are configuration errors, reported with the offending path (for example
`Unrecognized key: "model"` under `profiles.coder`). See
[`kit-paths.md`](kit-paths.md) for the strict-form rule.

The effective order is:

```text
built-in role policy → profiles in config → steps override → capability frontmatter
```

An exact step override cannot replace an axis imposed by a capability. Broad
settings remain valid but are reported as dead by `--lint-config` when a
capability owns that axis.

## Tune individual steps with `steps`

Use the `steps` section when one pipeline or one step needs a different policy:

```json
{
  "steps": {
    "*": { "model": "opus" },
    "release:*": { "effort": "medium" },
    "release:review": { "model": "sonnet", "effort": "low" }
  }
}
```

Keys are `*`, `<pipeline>:*`, or `<pipeline>:<stepId>`, from broadest to most
specific. Only `model` and `effort` are accepted. The override applies after the
pipeline is built and before the first spawn; it is validated against the loaded
pipeline. Targeting a missing step, a Bash/action step, or an axis imposed by a
capability is an error. A key for a different pipeline is ignored during a run
but reported by the lint command.

Check all reachable pipelines with the low-level command:

```bash
bun /path/to/lance-nuit/src/runner.ts --lint-config
```

The report shows effective model/effort and their source for every agent step,
regardless of backend. Tracker and other `actionStep`s have no such axes.

## opencode specifics

opencode has no equivalent of the codex `sandbox` option. Its only
per-invocation permission control is the agent, and the runner derives it from
the role:

| Role | Agent | Tools |
|---|---|---|
| `extractor`, `triage`, `relay` | `lance-nuit-bare` | none |
| `reviewer`, `planner` | `lance-nuit-ro` | read only (`write`, `edit`, `bash` and `patch` disabled) |
| `coder`, `operator`, any other role | `lance-nuit-runner` | all |

An explicit `options.agent` always wins over the role default.

The runner writes its own `opencode.json` under the system temp directory and
exports it as `OPENCODE_CONFIG`, because an explicit agent prompt and a per-agent
tool map are only reachable through a config file. Two consequences: the user's
own `opencode.json` is ignored, and the project's `AGENTS.md` and personal
`~/.claude/CLAUDE.md` are **not** injected — a deterministic pipeline must not
inherit context it did not choose.

Cost is reported per step by the provider, and a reported non-zero cost is taken
as exact. A reported `0` is not: opencode emits the field on every step and
writes `0` for any model it cannot price itself (a custom provider, Copilot,
Ollama, a model missing from its catalog). So a `0` on a step that spent tokens
is read as a missing price, and the runner falls back to the rates declared in
`.lance-nuit/pipeline-history/pricing.json`, flagged as an estimate. With no rate
for the model, the step keeps `0` as its amount but is recorded `cost_unknown`
rather than exact. Only a `0` reported without a single token — a genuinely free
turn — is an exact zero. No price of another model is ever substituted.

## Capacity escalation on failure

Retry policy is declared on `onFail`; escalation changes the next attempt's
capacity without changing the step's nominal profile:

```ts
llmStep({
  id: "review",
  name: "Review",
  backend: "claude",
  profile: "reviewer",
  command: "Review the change and return a verdict",
  onFail: {
    retries: 2,
    escalate: { effort: "high", model: "opus[1m]", after: 1 },
  },
});
```

For ordinary failures the runner escalates effort first, then model; a wall-clock
timeout can switch model directly. Escalation is sticky (it never moves back to
a lower rung), and all attempts count toward the configured cost ceiling.
See [Failures, retries, and capacity escalation](failures-retries-escalation.md)
for the complete failure lifecycle. Human review is a separate mechanism covered
in [Human control](human-control.md).
