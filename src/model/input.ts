// runner/model/input.ts
//
// Admission contracts of a step: the shapes an author declares through `input`.
// The builders that produce them live in `dsl/input.ts`.

import type { AsyncTemplated, PipelineContext } from "./context.js";
import type { RunStopState } from "./persisted.js";

export type InputAction = "skip" | "fail" | "stop";
export type WhenOutcome = InputAction;
/** `stop` travels with the decision so a gate can describe why it stops without
 *  the runner parsing the reason string. It is only read for a `stop` action. */
export type InputDecision = { action: "pass" } | { action: InputAction; reason: string; stop?: RunStopState };
export type InputPredicateResult = boolean | { ok: boolean; reason?: string; stop?: RunStopState };
export type InputPredicate = (ctx: PipelineContext) => InputPredicateResult | Promise<InputPredicateResult>;

/** Common authoring form for admissions. A bare predicate means
 * `{ if: predicate, else: "skip" }`. `unless` is its negative form: the
 * condition used when the predicate expresses why execution should not occur. */
export type When =
  | InputPredicate
  | { if: InputPredicate; else?: WhenOutcome }
  | { unless: InputPredicate; else?: WhenOutcome }
  | { command: AsyncTemplated<PipelineContext>; else?: WhenOutcome };

/** A frozen admission is not reevaluated once the step has materialized an
 *  irreversible state — for example, orchestration has already created a child. */
export interface FrozenOnStart {
  readonly frozenOnStart?: boolean;
}

export interface FunctionInputCondition extends FrozenOnStart {
  readonly kind: "function";
  evaluate(ctx: PipelineContext): InputDecision | Promise<InputDecision>;
}

export interface CommandInputCondition extends FrozenOnStart {
  readonly kind: "command";
  readonly command: AsyncTemplated<PipelineContext>;
  readonly onFailure: InputAction;
}

export type StepInputCondition = FunctionInputCondition | CommandInputCondition;

export interface InputPolicy {
  readonly action: InputAction;
  readonly reason?: string;
}
