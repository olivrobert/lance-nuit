# Builtin review steps in TypeScript

[`pipeline.ts`](pipeline.ts) is a compilable reference collection of review
steps written directly in the DSL:

| Step | DSL id |
| --- | --- |
| Acceptance Criteria | `review.acceptance-criteria` |
| Constraints | `review.constraints` |
| Reuse Audit | `review.reuse-audit` |
| E2E Testing | `review.e2e-testing` |
| Quality Retrospective | `finalize.quality-retrospective` |

Projects add their own `bashStep`, `llmStep`, or `actionStep` when they have a
real quality command to run.

The example shows blocking flags, two preconditions (`reuse-watch.md` and
`e2e-scenarios.md`), app URL guards, report paths, capability qualification, and
a non-blocking retrospective step. Add `onFail` explicitly when the surrounding
project pipeline has a repair policy.

To use this as a project starting point, copy the steps into
`.lance-nuit/pipelines/<name>.ts`, install the generated DSL declarations, and
run `lancenuit typecheck`.
