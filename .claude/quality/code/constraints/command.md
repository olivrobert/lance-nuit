---
paths:
  - "src/commands/*.ts"
exclude:
  - "src/commands/*.test.ts"
  - "src/commands/approval-subject.ts"
  - "src/commands/lint-config-check.ts"
  - "src/commands/pipeline-reference.ts"
  - "src/commands/pipeline-templates.ts"
  - "src/commands/registries.ts"
  - "src/commands/runner-command.ts"
  - "src/commands/shared.ts"
---

# Constraints — CLI commands

Scope: `src/commands/*.ts` matching `Module exporting a `RunnerCommand` (id, flag, key, desc, run) wired into COMMANDS.`.

Tooling checked: `biome.json`, `eslint.config.mjs`, `tsconfig.json`, `.dependency-cruiser.cjs`, `package.json`, `scripts/check-public-language.mjs`. None of the rules below are covered by this tooling.

## Static Rules

```rules
CMD-002 | absent | process\.exit\( | MUST NOT The `run` handler does not terminate the process, it returns an exit code
```

## Semantic Rules

- MUST: The command is exported as a const named `<name>Command` annotated `: RunnerCommand`. Trigger: module in src/commands/ declaring a CLI command. Anchor: `export const xxxCommand: RunnerCommand = { ... }` at module level. — consistency, non-blocking (11/12)
- MUST: A failure is explained to the user via `log()` before returning 1. Trigger: failure branch of a `run` handler that returns 1. Anchor: `log(...)` call from ../runtime/logging.js on the failure path. (6/6)
- MUST: The `desc` field is a complete English sentence ending with a period. Trigger: declaration of a `desc` field in a command object. Anchor: `desc:` string ending with `.`. — consistency, non-blocking (11/11)
- SHOULD: The command's logic is a function exported from the module, with `run` limited to wiring arguments and the exit code. Trigger: command whose processing goes beyond delegating a single call. Anchor: `export function`/`export async function` at module level, called from `run`. (6/7)
