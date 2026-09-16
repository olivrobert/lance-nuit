---
paths:
  - "src/step/*.ts"
exclude:
  - "src/step/*.test.ts"
---

# Constraints — Step execution

Scope: `src/step/*.ts` matching `Module under src/step/ driving one stage of the step loop: admission, attempt, verdict, failure policy, fix loop, nested pipeline orchestration.`.

Tooling checked: `biome.json`, `eslint.config.mjs`, `tsconfig.json`, `package.json`. None of the rules below are covered by this tooling.

## Static Rules

```rules
STP-004 | absent | step\.status\s*=[^=] | MUST NOT A step module does not directly assign `step.status`
```

## Semantic Rules

- MUST NOT: A step module does not address an execution message to the global logger. Trigger: message intended for the operator (progress, warning, halt) emitted during step execution. Anchor: an `output.emit({ type: "runner.message", ... })` call on the injected `RunOutput` port, and no `log.warn`/`log.info` call. (15/16)
- MUST: A caught error is normalized via `errorMessage()` before becoming a failure reason. Trigger: `catch (error)` block that turns the exception into a persisted or displayed reason. Anchor: `errorMessage(error)` from `lib/errors.js` in the catch body. (5/5)
- MUST: A gate that withholds work on a cost decision records the stop via `recordCostStop`. Trigger: `costDecision(...)` other than `continue` before a spawn, a retry, a repair or a child launch. Anchor: `recordCostStop(run, budget, decision, { kind: "gate", stepId })` before the return or break. (5/5)
- MUST: A `*Deps` interface types each replaceable collaborator via `typeof` of its production function. Trigger: declaration of an injectable dependencies object for a step-loop phase. Anchor: `name: typeof productionFunction` in the `*Deps` interface, never a hand-rewritten signature. (5/5)
- MUST: Interruption is re-checked after each awaited attempt or child, before continuing. Trigger: `await` of an attempt (`runAttempt`, `runFixAttempt`, `performFixAttempt`) or of a child execution (`executeChild`, `executeRunSteps`). Anchor: `abort.isRunAborted(run)` from the injected scope (or `run.aborted` for the verdict phase) tested right after the await. (7/7)
