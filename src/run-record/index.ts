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

// Reading a run: the snapshot reconciled with its journal and the status a
// reader shows, the attempts and events only the journal holds, and the journal
// health `--inspect` reports.
export {
  lastJournalEvent,
  type RunHistory,
  type RunRead,
  readLatestRun,
  readListedRun,
  readRun,
  readRunHistory,
} from "./run-read.js";
export { type RunJournalReport, readRunJournal } from "./run-journal.js";
export { runEventsFilePath } from "./stores/file-run-event-store.js";

// Attempts and their logs, and the cost ledger and budget a run is held to: an
// attempt is opened and settled here, the ledger an execution spends against is
// opened here, and every site about to spend asks the one cost gate.
export {
  type AttemptResult,
  type CostWarning,
  type OpenedAttempt,
  openAttempt,
  settleAttempt,
} from "./attempt-lifecycle.js";
export { isBudgetExceeded, type RunBudget, remainingBudget, strictCostAccountingFor } from "./budget.js";
export {
  chargeChildReconciliation,
  costIsLowerBound,
  measuredRunCost,
  openRunLedger,
  runProvesUnpricedSpend,
} from "./cost-accounting.js";
export { costGate, inheritChildBudgetStop, ledgerStops } from "./cost-stop-events.js";
export {
  ATTEMPT_COMMAND_FILE,
  findStepLog,
  latestAttemptLog,
  logicalAttemptLogPath,
  matchesStepSelector,
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

// Opening and restoring a run: the stores and the projection boot reads a run
// with before executing it, and the raw snapshot and journal writes. The stores
// also serve as ports: the statistics of the run a process just executed read
// its journal through one, and `--inspect` lists snapshots through the other
// before reading each with `readListedRun`.
export { restoreRunTotals } from "./cost-accounting.js";
export { appendRunEvent, readRunEvents } from "./run-journal.js";
export { type ProjectedRunState, projectRunState, settleCrashedAttempts } from "./run-projection.js";
export { FileRunEventStore } from "./stores/file-run-event-store.js";
export { FileRunStateStore } from "./stores/file-run-state-store.js";
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
  type RunsLocation,
  runsLocationOf,
  wouldResumeLatest,
} from "./stores/run-storage.js";
