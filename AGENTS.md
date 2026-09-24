# Repository instructions

Use the existing documentation as the source of truth instead of restating it
in this file.

## Start here

- Read [README.md](README.md) for the product overview, execution model, quick
  start, requirements, and the supported integration surface.
- Use [guide/index.md](guide/index.md) as the documentation router. Read only
  the guides relevant to the change you are making.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing code, tests, public
  text, generated documentation, CLI behavior, or dependencies.
- When creating or modifying a source file, look it up in
  [.claude/skills/skill-mapping.md](.claude/skills/skill-mapping.md) and use the
  matching `quality-*` skill; it routes to the quality constraints for that kind
  of file.

## Topic routing

- Pipeline authoring, composition, prompts, extractors, or project types:
  [guide/dsl.md](guide/dsl.md),
  [guide/dsl-typecheck.md](guide/dsl-typecheck.md),
  [guide/prompts.md](guide/prompts.md), and
  [guide/extractors.md](guide/extractors.md).
- Agent backends, profiles, retries, cost limits, timeouts, or tracing:
  [guide/agents-profiles-backends.md](guide/agents-profiles-backends.md),
  [guide/failures-retries-escalation.md](guide/failures-retries-escalation.md),
  [guide/budgets-timeouts.md](guide/budgets-timeouts.md), and
  [guide/sessions-tracing.md](guide/sessions-tracing.md).
- Work items, human review, approvals, and provider boundaries:
  [guide/work-item-layout.md](guide/work-item-layout.md),
  [guide/work-item-port.md](guide/work-item-port.md), and
  [guide/human-control.md](guide/human-control.md).
- CLI, configuration paths, persistence, extensions, or internal structure:
  [guide/cli-options.md](guide/cli-options.md),
  [guide/kit-paths.md](guide/kit-paths.md),
  [guide/persistence.md](guide/persistence.md),
  [guide/packages-and-extensions.md](guide/packages-and-extensions.md), and
  [guide/architecture.md](guide/architecture.md).
- Public DSL symbols and signatures: consult
  [docs/DSL-API.md](docs/DSL-API.md), but do not edit it by hand; regenerate it
  as described in [CONTRIBUTING.md](CONTRIBUTING.md).
- Concrete integration usage: consult the matching README under
  [examples/](examples/).

## Keep responsibilities clear

When changing existing code, favor clear, bounded responsibilities and explicit
state changes, especially in execution, persistence, and cost accounting. 
Keep improvements local to the task and follow the
existing boundaries in [guide/architecture.md](guide/architecture.md).

- Make it clear which component owns each rule and state change. Avoid spreading
  the same responsibility across several modules or adding coordinated mutations
  of shared state.
- Keep execution order and side effects explicit so understanding a change does
  not require reconstructing hidden interactions between modules.
- Distinguish authoritative state from derived values and caches. Preserve
  interruption, resume, and accounting guarantees when changing their relationship,
  and test the invariants affected by the change.
- Prefer simpler ownership over additional files, layers, or abstractions. Do not
  expand a routine change into a broad refactor.

## Keep documentation coherent

- Keep `README.md` concise and oriented toward discovery and first use. Put
  detailed explanations in the appropriate guide and link to them.
- Update the relevant documentation when behavior or public interfaces change.
- Write public-facing text in English.
- Run checks proportionate to the change; use the full verification list in
  `CONTRIBUTING.md` when preparing a complete contribution.
- Format with `bun run format` (Biome). Never run `npx prettier`: it pulls an
  external version and rewrites files against the repository style.
