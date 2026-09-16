---
paths:
  - "src/modules/read-model/*.ts"
exclude:
  - "src/modules/read-model/*.test.ts"
  - "src/modules/read-model/index.ts"
  - "src/modules/read-model/types.ts"
  - "src/modules/read-model/test-harness.ts"
---

# Constraints — Dashboard read model

Scope: `src/modules/read-model/*.ts` matching `Read-only composer under src/modules/read-model/ — the only module allowed to import the runner's state internals, producing dashboard-facing shapes.`.

Tooling checked: `package.json`, `biome.json`, `eslint.config.mjs`, `tsconfig.json`, `.dependency-cruiser.cjs`, `.semgrep.yml`. None of the rules below are covered by this tooling.

## Semantic Rules

- MUST NOT: A read-model file calls no filesystem write API. Trigger: any use of `node:fs` from the read model. Anchor: only `node:fs` read functions (`readdirSync`, `readFileSync`, `statSync`, `realpathSync`) appear in imports and calls. (7/7)
- MUST: A direct filesystem access is wrapped in a try/catch that returns a neutral value. Trigger: direct call to a `node:fs` function (readdirSync, readFileSync, statSync, realpathSync). Anchor: a `catch` block that returns the empty value of the return type (`[]`, `null`, `undefined`, `false`) and a comment stating why the failure is acceptable. (4/4)
- MUST: An exported entry point receives `options: ReadModelOptions = {}` as its last parameter. Trigger: exported function that reads disk for the dashboard. Anchor: the `options: ReadModelOptions = {}` parameter at the end of the signature, and the environment read via `options.env ?? process.env`. (6/6)
- MUST: A view whose run cannot be resolved returns `undefined` rather than an error. Trigger: entry point indexed by `project/ticket` whose resolution goes through `resolveRun`. Anchor: a `… | undefined` return type and a `return undefined` for each failure cause (project not listed, path gone, work item without a run). (4/4)
- MUST: Translating a persisted value the read model doesn't know returns a neutral value from the dashboard vocabulary. Trigger: conversion of a `PersistedRun` / `PersistedStepState` / contracts field to a `types.ts` type. Anchor: a switch `default:` branch, or a `?? "…"`, that returns the neutral value of the dashboard type (`RUNNING`, `pending`, `other`, `undefined`). (3/3)
- MUST: A store from the state layer is constructed inside the function that uses it, never kept at module level. Trigger: use of a store from `src/state/stores/`. Anchor: `new File…Store(...)` appears inside a function, or is passed as a parameter, never in a module-level constant. (3/3)
- MUST: A string coming from the caller is validated before entering a file path. Trigger: concatenation of an identifier received as a parameter (ticket, subject, launch id, relative path) into a `join`/`resolve`. Anchor: a guard (`isTicketToken`, `isValidLaunchId`, `isValidSubjectToken`, `isSafeRelativePath`, `isPathWithin`) called before the join, returning a neutral value when it rejects. (4/5)
- SHOULD: An optional field of a view is added via conditional spread rather than assigned `undefined`. Trigger: construction of an object rendered to the dashboard carrying optional fields. Anchor: `...(value ? { field: value } : {})` in the rendered literal, instead of `field: value ?? undefined`. — consistency, non-blocking (4/4)
