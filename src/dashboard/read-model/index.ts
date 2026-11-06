//
// Public surface of the read model — the ONLY module allowed to import
// `src/run/record` and `src/work-items/store`. The dashboard (`src/dashboard/ui/`)
// imports this file and nothing below it; a Semgrep `ERROR` rule in
// `.semgrep.yml` enforces that direction.

export type {
  RunReport,
  RunReportCaptureGroup,
  RunReportCriterion,
  RunReportDelivered,
  RunReportFollowUp,
  RunReportLink,
  RunReportNote,
  RunReportProof,
  RunReportReview,
} from "../../definition/index.js";
// The dashboard must refuse a reason or a subject the runner would refuse, before spawning.
export { isValidSubjectToken, MAX_REJECTION_REASON } from "../../work-items/index.js";
export type { ProjectEntry, ReadModelOptions } from "./projects.js";
export type { ApiRunFilters } from "./read-api.js";
export {
  type ApiRunDetail,
  type ApiRunList,
  type ApiRunStatus,
  READ_API_VERSION,
  readApiJsonSchemas,
} from "./read-api.schema.js";
export { createReadModel, type ReadModel } from "./read-model.js";
export type { ReportRead } from "./report.js";
export { isTicketToken, ticketPrefixOf, validateTicketRef } from "./tickets.js";
export type {
  ApprovalState,
  CoderSessionRead,
  FileContentKind,
  FileRead,
  ImageRead,
  Item,
  ItemApproval,
  ItemClosure,
  ItemCost,
  ItemFailKind,
  ItemFailure,
  ItemGroup,
  ItemProject,
  ItemStatus,
  ItemStop,
  ItemStopKind,
  Launch,
  LaunchRecord,
  RunEventView,
  RunJourney,
  RunJourneyAttempt,
  RunModelCost,
  RunPause,
  RunRecap,
  RunRecapStep,
  RunStepStatus,
  RunStepsView,
  RunStepView,
  RunTokens,
  StatsArchiveState,
  StatsHandover,
  StatsRead,
  StatsRun,
  StatsSource,
  StatsTicket,
  StepAttemptStatus,
  StepAttemptView,
  StepDetail,
  TextExcerpt,
  TicketKind,
  TicketOutcome,
  TreeDirectory,
  TreeFile,
  TreeNode,
  WorkItemTree,
} from "./types.js";
