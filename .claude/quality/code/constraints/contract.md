---
paths:
  - "src/contracts/**/*.ts"
exclude:
  - "src/contracts/**/*.test.ts"
---

# Constraints — Public contracts

Scope: `src/contracts/**/*.ts` matching `Module under src/contracts/ — the published extension surface: exported types, ports and registries consumed by backends and extensions.`.

Tooling checked: `package.json`, `biome.json`, `eslint.config.mjs`, `tsconfig.json`, `.dependency-cruiser.cjs`, `scripts/check-public-language.mjs`. None of the rules below are covered by this tooling.

## Semantic Rules

- MUST: A backend options module publishes its frozen variant by deriving it via Omit of the model and effort axes. Trigger: a module in src/contracts/backends/ declares a backend options interface carrying model and effort. Anchor: export type <X>BackendOptions = Omit<<X>Options, "model" | "effort"> in the same module. (3/3)
- MUST: A backend options' effort field is typed by the shared EffortLevel type and not by a local union. Trigger: a backend options interface declares an effort field. Anchor: effort?: EffortLevel, with import type { EffortLevel } from "../backends.js". (3/3)
- MUST: A contract registry rejects an already-registered identifier by throwing an Error. Trigger: a Registry class exposed by contracts accepts a provider registration. Anchor: throw new Error(... is already registered) in the register method. (2/2)
- MUST NOT: A contract module carries no mutable state at module level. Trigger: a shared value is declared at the module level of a contract. Anchor: every module-level declaration is a const (table, pattern, default value), never let or var. (16/16)
</content>
