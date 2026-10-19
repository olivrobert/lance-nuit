// runner/run-record/index.ts
//
// Entry of the run record: a run's snapshot (`state.json`), its journal
// (`events.jsonl`), its attempt logs and closure file, the transitions that
// change them, and the cost ledger and budget kept inside the run. Code outside
// this folder imports this file only (`module-run-record-entry-only` in
// `.dependency-cruiser.cjs`); the other files are internals.
//
// The groups below say what each part of the surface is for. The entry exports
// only what code outside the folder calls.

// Meaning of a run status: the status a reader shows, what that status says, and
// the one precedence that picks a run's status, report headline and exit code.
export {
  awaitsFinalization,
  awaitsHuman,
  type EffectiveStatus,
  effectiveStatus,
  hasVerdict,
  isCompleted,
  isFailure,
  isHalted,
  isResumableStatus,
  type RunEndingKind,
  runEnding,
  VERDICT_STATUSES,
} from "./run-status.js";
export { recordedVerdict } from "./run-verdict.js";

// What a run or a step still owes, read from its steps.
export {
  allStepsSettled,
  hasUnfinishedWork,
  isPersistedRunComplete,
  isSettledStatus,
  lastPassInterrupted,
  owesWork,
  pendingSteps,
  replayedAfterInterruption,
} from "./run-predicates.js";

// Reading a run: its snapshot, its journal, and the projection of one onto the
// other.
export { projectStepAttempts } from "./attempt-projection.js";
export { type RunJournalEvent, type RunJournalReport, readRunJournal } from "./run-journal.js";
export { projectRunState } from "./run-projection.js";
export { readRunSnapshot } from "./run-snapshot.js";
export { FileRunEventStore, runEventsFilePath } from "./stores/file-run-event-store.js";
export { FileRunStateStore } from "./stores/file-run-state-store.js";

// Attempts and their logs, and the cost ledger and budget a run is held to.
export { closeAttempt } from "./attempt-closure.js";
export { costDecision, isBudgetExceeded, type RunBudget, remainingBudget } from "./budget.js";
export {
  chargeAttemptToLedger,
  chargeChildReconciliation,
  controlForRun,
  costIsLowerBound,
  isUnpricedSpend,
  measuredRunCost,
  runProvesUnpricedSpend,
  type SettledSpend,
} from "./cost-accounting.js";
export { inheritChildBudgetStop, recordCostStop } from "./cost-stop-events.js";
export {
  ATTEMPT_COMMAND_FILE,
  findStepLog,
  latestAttemptLog,
  logicalAttemptLogPath,
  matchesStepSelector,
  nextAttemptLogPath,
  writeAttemptCommand,
} from "./run-timeline.js";

// Run and step transitions during execution.
export {
  abortRun,
  absorbStepFailure,
  finalizeRun,
  type RunOutcome,
  recordAbsorbedInputs,
  recordStepVerdict,
  stopRun,
  updateStep,
} from "./run-transitions.js";

// Composed child calls: the transitions of a child run's reference.
export {
  bindChildRun,
  commitChildCall,
  completedSuccessfully,
  declareChild,
  failChildLaunch,
  hasJournaledChildStart,
  isChildSettled,
  recordChildStarted,
  settleChild,
  skipChild,
} from "./child-transitions.js";

// Opening and restoring a run, and the raw snapshot and journal writes.
export { restoreRunTotals } from "./cost-accounting.js";
export { appendRunEvent, readRunEvents } from "./run-journal.js";
export { type ProjectedRunState, settleCrashedAttempts } from "./run-projection.js";
export { saveRun } from "./run-repository.js";
export { describeRunSnapshotProblem, hasRunSnapshotEntry, readRunSnapshotDiagnostic } from "./run-snapshot.js";
export { makeRunStep } from "./run-step.js";
export { type RunDirResolution, releaseRunDir } from "./stores/run-storage.js";

// Run reports: the figures a report prints.
export { aggregateControl, aggregateUsage } from "./cost-accounting.js";

// Human closure of a run, which `lancenuit close` and the dashboard read.
export { closureOf, isClosureCurrent, readClosureAt, removeClosureAt, writeClosureAt } from "./closure.js";

// Run locations, selection and the run lock.
export { relativeRunPath } from "./run-journal.js";
export { discardedResumeNotice, type ExplicitRunSelection, selectExplicitRun } from "./run-selection.js";
export { FileRunLogStore } from "./stores/file-run-log-store.js";
export {
  createRunId,
  latestRunFile,
  pipelineRunsDir,
  RUNS_DIRECTORY,
  resolveLatestRunSnapshot,
  runLockHolder,
  wouldResumeLatest,
} from "./stores/run-storage.js";
