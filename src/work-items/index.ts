// What other contexts may import from this one: re-exports only, every name with a caller outside.
// `module-<context>-entry-only` in `.dependency-cruiser.cjs` holds the rule.
export type { Artifact, ArtifactParser } from "./artifact.js";
export { sourceDeclarationError } from "./source.js";
export type { Source, StepInput } from "./source.js";
export {
  FileWorkItemArtifactStore,
  MAX_REJECTION_REASON,
  PROVENANCE_PREFIX,
  adoptOutputs,
  artifactKey,
  decisionActor,
  decisionMatchesArtifact,
  fingerprintInputs,
  freshness,
  gateDecisionStatus,
  inputsReadAfterAttempt,
  inputsReadBeforeAttempt,
  inputsUnchanged,
  isInFlight,
  isValidSubjectToken,
  markInFlight,
  mergeProvenance,
  pendingRejection,
  pureInputsOf,
  readDecision,
  readDecisionIn,
  readInputs,
  readSource,
  recordApproval,
  recordRejection,
  rejectionStatus,
  revisedInPlace,
  standingOf,
  stepFreshness,
  workItemLayout,
  writeProvenance,
} from "./store/index.js";
export type {
  ApprovalDecision,
  ArtifactFreshness,
  InputFingerprint,
  RecordedApproval,
  UnavailableSource,
} from "./store/index.js";
