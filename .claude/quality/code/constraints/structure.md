---
paths:
  - "src/**/*.ts"
exclude:
  - "src/**/*.test.ts"
  - "src/**/test-harness*.ts"
  - "src/contracts/testing.ts"
  - "src/dashboard/ui/app/**"
---

# Constraints — Structure (single responsibility, no hidden coupling)

Scope: every runner module under `src/`, outside tests, test harnesses and the dashboard SPA (`src/dashboard/ui/app/`).

These rules are decisions, not measured conventions: they describe the target structure and the existing code does not meet them everywhere yet. A violation is debt to pay down when the file is touched, not a reason to reword the rule.

Tooling checked: `biome.json`, `eslint.config.mjs`, `tsconfig.json`, `.dependency-cruiser.cjs`. None of the rules below are covered by this tooling.

## Static Rules

```rules
STR-001 | absent | ^(export\s+)?const\s+\w+(\s*:[^=]+)?\s*=\s*new\s+WeakMap\b | MUST NOT attach hidden state to an object through a module-level WeakMap: carry it as an explicit field or parameter
STR-002 | absent | \bimport\(\s*["']\.\.?/ | MUST NOT import an internal module dynamically to dodge a cycle: inject the collaborator instead
```

## Semantic Rules

- MUST NOT: Module-level mutable state does not carry data from one function to another. Trigger: a module-level `let`, or a module-level `Map`/`Set`/array that one function writes and another reads. Anchor: the state lives in an object created per call (session, context, run) and passed explicitly; tolerated only for a process-wide setting (color, log hook) or a memo cache of a pure computation keyed by its input. — a hidden channel makes execution order impossible to read
- MUST NOT: A module whose name or folder declares reading writes, deletes or mutates. Trigger: exported function of a module named `*-reader(s)`, `inspect*`, or living in `read-model/` or `validation/`. Anchor: no `node:fs` write, unlink, rename or gzip call and no assignment to a field of a parameter; the mutating counterpart lives in a module named for it. — the name is the contract the caller trusts
- MUST: A `build()` method is idempotent. Trigger: a builder class declaring `build()`. Anchor: `build()` assembles a new object from the builder's fields and never reassigns, pushes into or wraps `this.*`; calling it twice yields two equal results.
- MUST: A function whose callers branch on several outcomes returns a discriminated union. Trigger: a function with three or more distinct exit causes (aborted, stopped, fixed, blocked, skipped…) that callers tell apart. Anchor: a return type made of literal-tagged variants (`{ kind: "…" } | { kind: "…" }`, or an `action`/`status` literal), never one boolean field reused for unrelated causes such as `{ failed: false }` for both an abort and a success. — an overloaded boolean hides branches from the reader and the type checker
- MUST NOT: A module outside `src/dashboard/ui/routes/` and `src/dashboard/ui/server.ts` decides an HTTP status. Trigger: a numeric HTTP status (400, 404, 409, 500) or a `Response` built in domain or service code. Anchor: the function throws or returns a typed domain error and the route maps it to a status. — transport stays at the edge
- SHOULD: A function runs one phase. Trigger: a function over about 80 lines that chains several independent guards or stages (cost gate, predicate, lock, replay, preflight…). Anchor: each stage is a named function called in sequence from a short orchestrating function.
- SHOULD: A module's exports serve the one responsibility its file name states. Trigger: an export that another module imports for an unrelated helper (formatting, path containment, name lookup, DTO shape). Anchor: the helper lives in a module named for it, imported by both.
