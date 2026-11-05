// runner/work-item-store/index.ts
//
// Entry of the work-item store: what the runner keeps next to a ticket, outside
// any run — the artifacts, the human decisions bound to them, and the provenance
// that says whether an output still answers to its inputs. Code outside this
// folder imports this file only (`module-work-item-store-entry-only` in
// `.dependency-cruiser.cjs`); the other files are internals.

// Freshness and provenance.
export {
  type ArtifactFreshness,
  adoptOutputs,
  fingerprintInputs,
  freshness,
  type InputFingerprint,
  inputsReadAfterAttempt,
  inputsReadBeforeAttempt,
  inputsUnchanged,
  isInFlight,
  markInFlight,
  mergeProvenance,
  PROVENANCE_PREFIX,
  pureInputsOf,
  readInputs,
  readSource,
  revisedInPlace,
  standingOf,
  stepFreshness,
  type UnavailableSource,
  writeProvenance,
} from "./provenance.js";

// Layout: where a work item keeps artifacts, decisions and provenance.
export { artifactKey, isValidSubjectToken, workItemLayout } from "./layout.js";

// Decisions and approvals.
export {
  type ApprovalDecision,
  decisionActor,
  decisionMatchesArtifact,
  gateDecisionStatus,
  MAX_REJECTION_REASON,
  pendingRejection,
  type RecordedApproval,
  readDecision,
  readDecisionIn,
  recordApproval,
  recordRejection,
  rejectionStatus,
} from "./decisions.js";

// Artifact store.
export { FileWorkItemArtifactStore } from "./file-work-item-artifact-store.js";
