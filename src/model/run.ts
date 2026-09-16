/** In-memory run shapes: the persisted schema (`model/persisted.ts`) merged with
 *  the frozen step definitions and runtime-only dependencies. */
import type { PipelineStep } from "./definition.js";
import type { PersistedAttempt, PersistedRun, PersistedStepState } from "./persisted.js";
import type { RunEventStore, RunLogStore, RunStateStore } from "./storage-ports.js";

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

/** In-memory step: MUTABLE run state (status, retries, control/usage, session)
 *  plus its frozen definition under `def`. The separation is structural:
 *  execution can no longer mutate the declaration accidentally.
 *
 *  Definition fields are not persisted in the state. */
export interface RunStep extends PersistedStepState {
  readonly def: StepDefinition;
  /** Attempts of this step, projected from the journal on resume. Runtime-only:
   *  the snapshot no longer carries them. */
  attempts: PersistedAttempt[];
  /** Last rendered command (for debugging only). Runtime-only: it is the whole
   *  agent prompt, and re-serializing it in every snapshot cost more than the
   *  rest of the run state put together. */
  last_command?: string;
}

/** In-memory run: merged definition and state.
 *
 *  Every persisted field is inherited from `PersistedRun`: a field added there is
 *  automatically available here, with no risk of the two shapes drifting apart.
 *  Only the differences are declared below. */
export interface Run extends Omit<PersistedRun, "pipeline_path" | "steps"> {
  /** Always resolved in memory, unlike the persisted snapshot. */
  pipeline_path: string;
  /** Run directory, derived at load time and never persisted. */
  run_dir: string;
  steps: RunStep[];
  /** Runtime-only dependency; never included in PersistedRun. */
  stateStore?: RunStateStore;
  /** Runtime-only dependency; never included in PersistedRun. */
  eventStore?: RunEventStore;
  /** Runtime-only dependency; never included in PersistedRun. */
  logStore?: RunLogStore;
}

/** Read-only view of a step for presentation. Shallow on purpose: it stops
 *  `step.status = ...` at the type level; nested objects are still shared. */
export type RunStepView = Readonly<RunStep>;

/** Read-only view of a run for the consumers that inspect or display it — the
 *  console report, the statistics projection — and must never move the run
 *  forward. Execution transitions take a `Run` and live in
 *  `state/run-transitions.ts`. Shallow, like `RunStepView`. */
export type RunView = Readonly<Omit<Run, "steps">> & { readonly steps: readonly RunStepView[] };
