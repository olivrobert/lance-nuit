// runner/run-record/index.ts
//
// Entry of the run record: a run's snapshot (`state.json`), its journal
// (`events.jsonl`), its attempt logs and closure file, the transitions that
// change them, and the cost ledger and budget kept inside the run. Code outside
// this folder imports this file only (`module-run-record-entry-only` in
// `.dependency-cruiser.cjs`); the other files are internals.
//
// The entry still re-exports every symbol used outside the folder when the
// files moved here. Each group names the change planned to retire it or narrow
// it, so the surface left to reduce reads from this file; a group marked "kept"
// is meant to stay.

// Status meaning: which status a run or a step stands in, read from a snapshot.
// Folded into one status map by L6, which also retires `isClosableStatus`.
export { isClosableStatus } from "./closure.js";
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
export { deriveRunStatus, isResumableStatus } from "./run-verdict.js";

// Projected reading of a run: replaced for readers by one `readRun` in L7.
// `FileRunEventStore` and `FileRunStateStore` stay for boot until L10.
export { projectStepAttempts } from "./attempt-projection.js";
export { type RunJournalEvent, type RunJournalReport, readRunJournal } from "./run-journal.js";
export { projectRunState } from "./run-projection.js";
export { readRunSnapshot } from "./run-snapshot.js";
export { FileRunEventStore, runEventsFilePath } from "./stores/file-run-event-store.js";
export { FileRunStateStore } from "./stores/file-run-state-store.js";

// Attempt and cost: absorbed by `openAttempt`, `settleAttempt`, `costGate` and
// `openRunLedger` in L8.
export { closeAttempt } from "./attempt-closure.js";
export { costDecision, isBudgetExceeded, type RunBudget, remainingBudget } from "./budget.js";
export {
  chargeAttemptToLedger,
  chargeChildReconciliation,
  controlForRun,
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

// Run and step transitions during execution. L8 absorbs `recordStepVerdict`;
// L9 adds the remaining named writes; L11 makes the run read-only outside.
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

// Composed child calls: kept, already named transitions.
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

// Opening and restoring a run: absorbed by `openRun` and `loadOrCreateRun` in
// L10, after which `saveRun` and `appendRunEvent` are no longer exported.
export { restoreRunTotals } from "./cost-accounting.js";
export { appendRunEvent, readRunEvents } from "./run-journal.js";
export { type ProjectedRunState, settleCrashedAttempts } from "./run-projection.js";
export { saveRun } from "./run-repository.js";
export { describeRunSnapshotProblem, hasRunSnapshotEntry, readRunSnapshotDiagnostic } from "./run-snapshot.js";
export { makeRunStep } from "./run-step.js";
export { type RunDirResolution, releaseRunDir } from "./stores/run-storage.js";

// Run reports: kept, the figures a report prints.
export { aggregateControl, aggregateUsage } from "./cost-accounting.js";

// Human closure of a run: kept, `lancenuit close` and the dashboard read it.
export { closureOf, isClosureCurrent, readClosureAt, removeClosureAt, writeClosureAt } from "./closure.js";

// Run locations, selection and the run lock: kept.
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
