/** Run shapes seen from outside the run record: the frozen step definitions and a
 *  read-only view of an executing run. The mutable run is internal to
 *  `src/run-record/` (`run-record/run.ts`): only its operations move a run, and
 *  every other module holds the view below. */
import type { PipelineStep } from "./definition.js";
import type {
  PersistedAttempt,
  PersistedPipelineChildRef,
  PersistedPipelineOrchestrationState,
  PersistedRun,
  PersistedStepState,
} from "./persisted.js";
import type { RunEventStore, RunLogStore } from "./storage-ports.js";

/** Step definition FROZEN when the run starts: `runner` is resolved and mutation
 *  is forbidden (`readonly` in types, `Object.freeze` at runtime). Pass this
 *  object to handlers and middleware: they may read the declaration but cannot
 *  write to it.
 *
 *  Not yet serializable: `command`, `action`, `inputs`, `outputs`, and
 *  `on_failure.fix_prompt` may contain closures. Removing them is separate work;
 *  immutability is established here. */
export type StepDefinition = Readonly<PipelineStep> & {
  readonly runner: NonNullable<PipelineStep["runner"]>;
};

/** `T` read-only at every depth, arrays included; functions are kept as they are.
 *  A shallow `Readonly` would still let `step.attempts.push(…)` or
 *  `run.outcome.reason = …` through. */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/** One attempt of a step, as the run record keeps it. */
export type RunAttemptView = DeepReadonly<PersistedAttempt>;

/** The state of a `runPipeline` / `forEachPipeline` node, and the reference it
 *  keeps for each child call. */
export type OrchestrationView = DeepReadonly<PersistedPipelineOrchestrationState>;
export type ChildRefView = DeepReadonly<PersistedPipelineChildRef>;

/** A step of an executing run: its persisted state and its frozen definition,
 *  read-only at every depth. */
export interface RunStepView extends DeepReadonly<PersistedStepState> {
  readonly def: StepDefinition;
  /** Attempts of this step, projected from the journal on resume. */
  readonly attempts: readonly RunAttemptView[];
}

/** An executing run, read-only at every depth. Code outside `src/run-record/`
 *  receives it from `openRun` and hands it back to the run record's operations
 *  (`updateStep`, `settleAttempt`, `finalizeRun`…), which alone write the run, its
 *  journal and its snapshot. Defined from the persisted shape, not from the
 *  mutable run, so no level below the run record names a type that can be
 *  written. */
export interface RunView extends DeepReadonly<Omit<PersistedRun, "pipeline_path" | "steps">> {
  /** Always resolved in memory, unlike the persisted snapshot. */
  readonly pipeline_path: string;
  /** Run directory, derived at load time and never persisted. */
  readonly run_dir: string;
  readonly steps: readonly RunStepView[];
  /** The pipeline declares `.reconcile()`, as boot loaded it. */
  readonly reconcile?: boolean;
  /** The journal and attempt-log stores a caller injected, if any. */
  readonly eventStore?: RunEventStore;
  readonly logStore?: RunLogStore;
}
