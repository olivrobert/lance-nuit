//
// Build a RunStep from a frozen definition and initial state. Hydration, new-run
// creation, and tests all use this boundary, so def/state shape has one definition.

import type { PipelineStep } from "../../definition/index.js";
import type { StepDefinition } from "../run.js";
import type { RunStep } from "./run.js";

/** Initial step state supplied by a new run or a snapshot. */
export type StepStateInput = Partial<Omit<RunStep, "id" | "def">>;

/** Freeze the step definition to protect the DSL/runtime boundary from untyped JS. */
export function stepDefinition(def: PipelineStep): StepDefinition {
  return Object.freeze(def as StepDefinition);
}

/** Frozen definition and mutable state pair for a step in a run. */
export function makeRunStep(def: PipelineStep, state: StepStateInput = {}): RunStep {
  const canonical = stepDefinition(def);
  return {
    def: canonical,
    id: def.id,
    status: state.status ?? "pending",
    retries: state.retries ?? 0,
    timeout_retries: state.timeout_retries,
    started_at: state.started_at,
    finished_at: state.finished_at,
    session: state.session,
    profile: state.profile ?? def.profile,
    control: state.control,
    usage: state.usage,
    errors: state.errors,
    fail_kind: state.fail_kind,
    fail_cause: state.fail_cause,
    attempts: state.attempts ? state.attempts.map((attempt) => ({ ...attempt })) : [],
    orchestration: state.orchestration,
  };
}
