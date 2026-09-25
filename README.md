# lance-nuit

[![CI](https://github.com/olivrobert/lance-nuit/actions/workflows/ci.yml/badge.svg)](https://github.com/olivrobert/lance-nuit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Status: experimental](https://img.shields.io/badge/status-experimental-orange.svg)

> **Resumable pipelines for shell commands and AI agents. Start them at night,
> read the report in the morning.**

A pipeline is a small TypeScript file: shell commands, AI agents, and a cost
budget. Use it to repair failing tests or take tickets through implementation
and review while you are away. In the morning, see what passed, what it cost,
and what needs your attention.

`lance-nuit` is French for "launch at night". That is the intended use: queue the
work, go to sleep, review in the morning.

- **Resume after interruption.** Re-run the same command to continue from the
  interrupted step, keeping completed steps and recorded spend.
- **Give failures a recovery plan.** Retry, ask an agent to repair the cause,
  escalate to a stronger model, or hand the work to a human.
- **Control agent spending.** Set a budget for the run, including repairs and
  retries. Inspect the costs, logs, and artifacts saved on disk.

[Quick start](#quick-start) · [Full nightly workflow](examples/nightly-tickets/README.md) · [Guides](guide/index.md)

## What a pipeline looks like

Give Claude a ticket to implement. Run the tests, letting a repair agent fix
failures before trying again. Then ask Codex to review the changes against the
ticket and leave a report for the morning. All three steps share a $5 budget:

<!-- project-pipeline-example:start -->
```ts
import type { Dsl } from "@lance-nuit/dsl";

export default ({ pipeline, llmStep, bashStep, mechanicalFix, textArtifact }: Dsl) =>
  pipeline("nightly")
    .desc("Implement a ticket, repair failing tests, and review the changes")
    .maxCost(5)
    .add(
      llmStep({
        id: "implement",
        name: "Implement",
        backend: "claude",
        profile: "coder",
        command: (ctx) => `Implement ${ctx.ticket}. Read the requirements in ${ctx.paths.artifact("ticket.md")}.`,
      }),
      bashStep({
        id: "test",
        name: "Run tests",
        command: "npm test",
        onFail: mechanicalFix(
          (ctx) => `The test suite failed. Fix the cause and change nothing else.\n\n${ctx.errors}`,
        ),
      }),
      llmStep({
        id: "review",
        name: "Review",
        backend: "codex",
        profile: "reviewer",
        options: { sandbox: "workspace-write" },
        command: (ctx) =>
          `Review the changes against ${ctx.paths.artifact("ticket.md")}. ` +
          `List bugs and unmet acceptance criteria in ${ctx.paths.artifact("review.md")}. Do not change the code.`,
        output: [textArtifact("review.md")],
      }),
    )
    .build();
```
<!-- project-pipeline-example:end -->

`mechanicalFix` opens a Claude session limited to reading and editing files;
the runner executes the tests after each repair. The review step must produce
`review.md` to complete. A successful run means the workflow finished; read the
report to decide whether the changes are ready.

`coder` and `reviewer` are roles: their models and effort levels live in config,
so you can tune them without rewriting the pipeline. The example is typechecked
against the project's DSL declarations.

With Claude Code and Codex installed and authenticated, save this as
`.lance-nuit/pipelines/nightly.ts` and commit it. Put the ticket requirements in
`.lance-nuit/work-items/PROJ-42/artifacts/ticket.md`, then launch
`lancenuit run PROJ-42 --pipeline nightly`. This example needs no ticket tracker;
the [full nightly workflow](examples/nightly-tickets/README.md) fetches tickets
from a queue. A completed run might look like this:

```text
╭─ ✓ SUCCESS · nightly · PROJ-42
│  Pipeline completed successfully
│  3 completed
│  36m45s · $4.83 · 137,220 tok
│  Budget $4.83 / $5.00
╰────────────────────────────────────────

Executed steps
  ✓ Implement  24m11s · $3.25
  ✓ Run tests  6m02s · $0.87 · 1 retry
  ✓ Review  6m32s · $0.71

Files
  run     .lance-nuit/work-items/PROJ-42/runs/nightly/20260903-031504
  events  .lance-nuit/work-items/PROJ-42/runs/nightly/20260903-031504/events.jsonl
  log     .lance-nuit/work-items/PROJ-42/runs/nightly/20260903-031504/steps/test/attempt-002/output.log
```

The implementation is on disk, the tests passed after one repair, and the review
is in the work item's `artifacts/review.md`. If the process is interrupted during
review, re-run the same command: completed implementation and test steps stay
completed, and recorded spend still counts toward the budget.

The budget guard reacts to usage reported by the backend, so an in-flight
agent can exceed the ceiling before its spend is known. See
[budgets and timeouts](guide/budgets-timeouts.md) for enforcement details.

The same building blocks scale to a full night of work. The
[nightly ticket loop](examples/nightly-tickets/README.md) takes the next three
tickets from a queue and, for each one, opens a branch, implements the ticket,
repairs the tests, commits, has a second backend review the branch, and hands
the ticket to a human when the reviewer asks for one, all under a cost ceiling
per ticket.

## Quick start

### Prerequisites

**[Bun](https://bun.sh) 1.3 or newer** — the runtime. It loads the TypeScript
pipelines directly. npm installs lance-nuit; it does not install Bun.

- macOS/Linux: `curl -fsSL https://bun.sh/install | bash`, then open a new shell
- Homebrew: `brew install oven-sh/bun/bun` — version managers: `mise use -g bun@1.3`
- Check: `bun --version`

**Git** — a fresh run refuses to start on a dirty tree.

**Bash 4+** — for shell steps and the `lancenuit` wrapper, including on macOS.
Linux is verified in CI; native Windows execution is not supported, so use WSL
or another Linux environment.

**An agent CLI** — for agent steps only. Claude Code, Codex or opencode.

- [Claude Code](https://claude.ai/code), macOS/Linux/WSL:
  `curl -fsSL https://claude.ai/install.sh | bash`

Node.js is not required to use lance-nuit: it is used for development and for
installation through npm.

### Install

There is no registry release yet, so install from a checkout. Bun loads the
TypeScript sources directly; nothing has to be built.

```sh
git clone https://github.com/olivrobert/lance-nuit
cd lance-nuit
bun install --frozen-lockfile
ln -s "$PWD/bin/lancenuit" ~/.local/bin/lancenuit   # any directory on the PATH
lancenuit --version
```

The wrapper follows the link back to the checkout, so it keeps running its
sources. Run `lancenuit` from the root of the project you want to automate, not
from this checkout. To equip a machine that has no checkout, build a tarball with
`npm pack` and install it globally; see
[installation](guide/usage.md#installation).

### Run your first pipeline

From your project's root, choose a starting point. For tests without an agent:

```sh
lancenuit create nightly --command "npm test"
```

For tests with automatic repair, use this command instead (requires Claude
Code installed and authenticated):

```sh
lancenuit create nightly --template checked --command "npm test"
```

`lancenuit create` writes `.lance-nuit/pipelines/nightly.ts`, installs the DSL
declarations, and typechecks the result. The `checked` template adds
`mechanicalFix` and a $2 budget. Then commit and run:

```sh
git add .lance-nuit && git commit -m "Add nightly pipeline"
lancenuit run PROJ-42 --pipeline nightly
```

A fresh run refuses to start on a dirty Git tree.

If the process is interrupted or a step fails, run the same command again. It
resumes. Add `--fresh` only when you want a brand-new run.

### Templates

Start from the capability you actually want; every template is typechecked by
the test suite and meant to be edited in place.

| Template | What it shows |
| --- | --- |
| `bash` (default) | One shell step. Requires `--command`. No agent. |
| `checked` | A shell step an agent repairs on failure, under `.maxCost()`. Requires `--command` and Claude Code. |
| `agent` | One agent step: explicit backend, semantic role, retry escalation. Requires Claude Code. |
| `review` | A shell check, then a reviewer agent that must produce a report artifact. Requires `--command` and Claude Code. |
| `work-item` | A work-item loop: triage each ticket, escalate the ones a human must decide. Requires Claude Code and a tracker. |

### Inspect, approve, clean up

```sh
lancenuit inspect PROJ-42
lancenuit logs PROJ-42 --step check
lancenuit list
lancenuit approve release-42 release --pipeline release
lancenuit clean --logs-only --older-than 30d
```

## What is in the box

Three step kinds:

| Step | Use it for |
| --- | --- |
| `bashStep` | Shell commands and project tools |
| `actionStep` | Deterministic in-process TypeScript actions |
| `llmStep` | Claude, Codex, opencode, or another registered agent backend |

Composition helpers are injected into the DSL:

`runPipeline({ id, name, pipeline, ticket?, when? });`

`forEachPipeline({ id, name, items, pipeline, when?, afterEach?, afterAll? });`

They add nested pipelines, sequential work-item processing, artifacts,
conditional admission, approvals, Git worktrees, and reports. The full surface
is in the [generated DSL API](docs/DSL-API.md) and the [DSL guide](guide/dsl.md).

Agents use roles such as `coder`, `planner`, and `reviewer`. Each role maps to a
model and effort per backend in `.lance-nuit/config.json` (project), merged
over `~/.lance-nuit/config.json` (user). Change models without rewriting the
pipeline. See
[agents, profiles, and backends](guide/agents-profiles-backends.md).

## Integrations are opt-in

A pipeline that only runs shell commands loads nothing else. Integrations
initialize only when a loaded pipeline uses them:

- `claude`, `codex` and `opencode` agent steps need the matching CLI installed.
- Work items come from Jira (`acli`) or GitHub (`gh`); GitLab helpers use `glab`.
- Docker stack preflight is enabled explicitly through `stackPreflight`.
- Extensions are explicit manifests that register local factories or npm
  packages, for example a Redmine adapter. See
  [packages and extensions](guide/packages-and-extensions.md).

Worked examples: [portable shell](examples/generic-shell/README.md),
[nightly ticket loop](examples/nightly-tickets/README.md),
[Jira](examples/jira-acli/README.md), [GitHub](examples/github-gh/README.md),
[GitLab](examples/gitlab-glab/README.md). They use fake executables in tests and
need no network access.

## Status

Experimental (`0.1.0`). The execution and persistence model is tested; the
public API may still change before `1.0.0`.

## Documentation

Start at the [guide hub](guide/index.md). Most-read pages:
[DSL](guide/dsl.md),
[failures, retries and escalation](guide/failures-retries-escalation.md),
[budgets and timeouts](guide/budgets-timeouts.md),
[human control](guide/human-control.md),
[CLI options](guide/cli-options.md).

## Development

```sh
bun install --frozen-lockfile
bun run lint
bun run format:check
bun test
bun run typecheck
bun run verify:production
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full verification list.

## License

MIT. See [LICENSE](LICENSE).
