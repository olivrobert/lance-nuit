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
STP-005 | absent | \bsaveRun\( | MUST NOT A step module does not persist the run itself: the `run-record` operation that writes a field saves the snapshot
```

## Semantic Rules

- MUST NOT: A step module does not address an execution message to the global logger. Trigger: message intended for the operator (progress, warning, halt) emitted during step execution. Anchor: an `output.emit({ type: "runner.message", ... })` call on the injected `RunOutput` port, and no `log.warn`/`log.info` call. (15/16)
- MUST: A caught error is normalized via `errorMessage()` before becoming a failure reason. Trigger: `catch (error)` block that turns the exception into a persisted or displayed reason. Anchor: `errorMessage(error)` from `lib/errors.js` in the catch body. (5/5)
- MUST: A site about to spend asks the run record's one cost gate and keeps only its own message. Trigger: a spawn, a retry, a repair, a re-ask or a child launch that a cost stop may withhold. Anchor: `const stop = costGate(run, budget, stepId)` (`run-record`) before the return or break; the gate records the stop, so no step module decides or records a cost stop itself. (6/6)
- MUST: A `*Deps` interface types each replaceable collaborator via `typeof` of its production function. Trigger: declaration of an injectable dependencies object for a step-loop phase. Anchor: `name: typeof productionFunction` in the `*Deps` interface, never a hand-rewritten signature. (5/5)
- MUST: Interruption is re-checked after each awaited attempt or child, before continuing. Trigger: `await` of an attempt (`runAttempt`, `runFixAttempt`, `performFixAttempt`) or of a child execution (`executeChild`, `executeRunSteps`). Anchor: `abort.isRunAborted(run)` from the injected scope (or `run.aborted` for the verdict phase) tested right after the await. (7/7)
