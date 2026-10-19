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

// Decisions and approvals.
export {
  type ApprovalDecision,
  approvalFreshness,
  approvalStatus,
  decisionActor,
  decisionMatchesArtifact,
  isValidSubjectToken,
  MAX_REJECTION_REASON,
  pendingRejection,
  type RecordedApproval,
  readDecision,
  readDecisionAt,
  recordApproval,
  recordRejection,
  rejectionPending,
  rejectionStatus,
} from "./decisions.js";

// Artifact store.
export { FileWorkItemArtifactStore } from "./file-work-item-artifact-store.js";

// Hash.
export { sha256Text } from "./hash.js";
