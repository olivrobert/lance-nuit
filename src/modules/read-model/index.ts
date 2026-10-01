// modules/read-model/index.ts
//
// Public surface of the read model — the ONLY module allowed to import
// `src/state`. The dashboard (`src/modules/ui/`) imports this file and nothing
// below it; a Semgrep `ERROR` rule in `.semgrep.yml` enforces that direction.

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
} from "../../model/run-report.js";
export {
  contentKindOf,
  IMAGE_LIMIT_BYTES,
  RAW_IMAGE_LIMIT_BYTES,
  readFile,
  readImage,
  readTree,
  TEXT_LIMIT_BYTES,
} from "./explorer.js";
export { GROUP_ORDER, listItems, readItem } from "./items.js";
export { readLaunches, readLaunchesFor } from "./launches.js";
export {
  type ProjectEntry,
  type ReadModelOptions,
  readProjects,
  ticketUrl,
  workItemsRoot,
} from "./projects.js";
export { createReadModel, type ReadModel } from "./read-model.js";
export { readRecap } from "./recap.js";
export { parseRunReport, type ReportRead, readReport } from "./report.js";
export { readStats, STATS_ARCHIVE_FILE, STATS_CONFIG_FILE } from "./stats.js";
export { readCoderSession, readSteps } from "./steps.js";
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
  RunModelCost,
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
  TicketKind,
  TicketOutcome,
  TreeDirectory,
  TreeFile,
  TreeNode,
  WorkItemTree,
} from "./types.js";
