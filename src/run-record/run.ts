// runner/run-record/run.ts
//
// The mutable run: the persisted schema (`model/persisted.ts`) merged with the
// frozen step definitions and runtime-only dependencies. It is internal to the
// run record. Code outside this folder holds a `RunView` (`model/run.ts`) and
// hands it back to the operations of the entry, which turn it into the run it
// views with `writable` and alone write it, its journal and its snapshot.

import type {
  ChildRefView,
  OrchestrationView,
  RunAttemptView,
  RunStepView,
  RunView,
  StepDefinition,
} from "../model/run.js";
import type {
  PersistedAttempt,
  PersistedPipelineChildRef,
  PersistedPipelineOrchestrationState,
  PersistedRun,
  PersistedStepState,
} from "../model/persisted.js";
import type { RunEventStore, RunLogStore, RunStateStore } from "../model/storage-ports.js";

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
  /** The pipeline declares `.reconcile()`. Boot sets it from the definition it
   *  loads the steps from, and every later reader takes it from here, so boot and
   *  the step loop cannot disagree on the mode. Runtime-only: the mode belongs to
   *  the pipeline, never to the snapshot. */
  reconcile?: boolean;
  /** The step whose pass this process started and has not ended, written by
   *  `updateStep` alone and read by `abortRun`. Runtime-only: a step left
   *  `running` by a runner that died is not executing, and only this process
   *  knows which one is. */
  executingStepId?: string;
  /** Runtime-only dependency; never included in PersistedRun. */
  stateStore?: RunStateStore;
  /** Runtime-only dependency; never included in PersistedRun. */
  eventStore?: RunEventStore;
  /** Runtime-only dependency; never included in PersistedRun. */
  logStore?: RunLogStore;
}

type Writable = Run | RunStep | PersistedAttempt | PersistedPipelineOrchestrationState | PersistedPipelineChildRef;

/** The run, step, attempt or orchestration record a view shows. Every view outside
 *  the module is an object this module created and handed out as a view
 *  (`openRun`, `openAttempt`, `openOrchestration`, `declareChild`), so this
 *  returns that same object: the view only took the right to write it away from
 *  the caller. This is the one place the module takes it back, and only the
 *  operations of the entry call it. */
export function writable(view: RunView): Run;
export function writable(view: RunStepView): RunStep;
export function writable(view: RunAttemptView): PersistedAttempt;
export function writable(view: OrchestrationView): PersistedPipelineOrchestrationState;
export function writable(view: ChildRefView): PersistedPipelineChildRef;
export function writable(view: RunView | RunStepView | RunAttemptView | OrchestrationView | ChildRefView): Writable {
  return view as Writable;
}
