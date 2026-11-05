// Why a run stopped cleanly. Apart from the persisted run because the authoring
// surface needs it too: a step's `when` predicate returns this shape, and pipeline
// authors must not depend on how a run is stored.

/** Expected recovery for a clean stop, in the reader's vocabulary. The first three
 *  mirror the review kinds a `humanReview` gate declares; `blocked` is the step
 *  fail cause of the same name — an obstacle outside the code. `until` is the
 *  bound an operator gave with `--until`: nothing is wrong, rerunning continues. */
export type RunStopKind = "needs-info" | "needs-decision" | "needs-human" | "blocked" | "until";

/** Structured cause of a clean stop, so a reader does not have to parse the
 *  console sentence stored in `stopped_reason`. */
export interface RunStopState {
  /** Approval subject that lifts the stop, when the gate declares one. */
  subject?: string;
  /** Artifact the gate is about (`artifacts/<name>`), when it reads one. A
   *  reader cannot derive it from `subject`: the binding lives in the pipeline,
   *  which only the runner loads. */
  artifact?: string;
  kind?: RunStopKind;
  /** Reason without the console decoration (`escalated:` prefix, `--approve` hint). */
  detail: string;
  /** The gate declares a rework step, so `--reject <subject>` is accepted. Only
   *  the runner loads the pipeline; a reader such as the dashboard learns from
   *  this flag whether rejecting is a way out. */
  reworkable?: boolean;
}
