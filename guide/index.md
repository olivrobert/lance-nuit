# Guides

This is the documentation hub for `lance-nuit`.

If you are new to the project, follow this path:

1. [Usage](usage.md) — install the runner and invoke the wrapper.
2. [DSL](dsl.md) — create and compose a TypeScript pipeline.
3. [Agents, profiles, and backends](agents-profiles-backends.md) — assign roles
   to Claude, Codex, or opencode and tune model/effort policy.
4. [Budgets and timeouts](budgets-timeouts.md) — bound cost and wall-clock time.
5. [Agent sessions and tracing](sessions-tracing.md) — inspect sessions, logs,
   events, and resume hints.

## Choose a topic

### Authoring pipelines

- [DSL](dsl.md) — project and shared pipeline definitions, builders, and
  composition.
- [Project DSL and typechecking](dsl-typecheck.md) — generated declarations and
  `lancenuit typecheck`.
- [Prompt files](prompts.md) — reusable prompts for built-in and project
  pipelines.
- [Output extractors](extractors.md) — normalize command output for fix loops.
- [Built-in pipelines](pipelines-builtin.md) — the technology-neutral `default`
  pipeline and optional integrations.

### Agents, policies, and failure handling

- [Agents, profiles, and backends](agents-profiles-backends.md) — explicit
  provider selection, semantic roles, and configuration overrides.
- [Budgets and timeouts](budgets-timeouts.md) — `.maxCost()`, per-work-item
  ceilings, pricing, token signals, and timeouts.
- [Failures, retries, and capacity escalation](failures-retries-escalation.md) —
  repair strategies and effort/model escalation on the selected backend.
- [Agent sessions and tracing](sessions-tracing.md) — backend sessions,
  resumed repairs, events, and durable trace files.

The DSL reference also documents `llmStep`, `onFail`, `escalate`, and the
provider-specific backend options: [generated DSL API](../docs/DSL-API.md).

### Work items and human control

- [Work-item layout](work-item-layout.md) — artifacts, reports, decisions, runs,
  and ticket directories.
- [Port work-item](work-item-port.md) — the provider-neutral tracker boundary,
  queues, escalation, delivery, and idempotence.
- [Human control](human-control.md) — work-item escalation, stop gates, and
  artifact-bound approvals.

### Operations and internals

- [Core contract and extensions](packages-and-extensions.md) — keep the app
  cohesive while adding local or npm adapters such as Redmine.
- [CLI options](cli-options.md) — runner flags and propagation rules.
- [Where kit files live](kit-paths.md) — project/user kit resolution and config
  precedence.
- [Persistence](persistence.md) — snapshots, artifacts, reports, and machine
  telemetry.
- [Architecture](architecture.md) — boot, dispatch, steps, backends, and state.

## Examples

- [Portable shell pipeline](../examples/generic-shell/README.md)
- [Nightly ticket loop](../examples/nightly-tickets/README.md)
- [Jira through `acli`](../examples/jira-acli/README.md)
- [GitHub through `gh`](../examples/github-gh/README.md)
- [GitLab through `glab`](../examples/gitlab-glab/README.md)

The core remains usable without these optional executables. Read the README's
[quick start](../README.md#quick-start) for the shortest working path.
