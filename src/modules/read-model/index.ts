// modules/read-model/index.ts
//
// Public surface of the read model — the ONLY module allowed to import
// `src/state`. The dashboard (`src/modules/ui/`) imports this file and nothing
// below it; a Semgrep `ERROR` rule in `.semgrep.yml` enforces that direction.

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
export {
  describeLaunch,
  isPidAlive,
  isValidLaunchId,
  launchesDir,
  launchPaths,
  readLaunches,
  readLaunchesFor,
  readLaunchRecord,
} from "./launches.js";
export {
  type ProjectEntry,
  projectsFile,
  type ReadModelOptions,
  readProjects,
  ticketUrl,
  uiDir,
  workItemsRoot,
} from "./projects.js";
export { readRecap } from "./recap.js";
export { readSteps } from "./steps.js";
export { isTicketToken, validateTicketRef } from "./tickets.js";
export type {
  ApprovalState,
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
  RunRecap,
  RunModelCost,
  RunRecapStep,
  RunStepStatus,
  RunStepsView,
  RunStepView,
  RunTokens,
  TreeDirectory,
  TreeFile,
  TreeNode,
  WorkItemTree,
} from "./types.js";
