// The shapes the dashboard receives over HTTP.
//
// Every DTO the server already owns is RE-EXPORTED from the module that owns
// it — the read model, the verbs, the terminals — rather than copied here. A
// second hand-written declaration would drift silently the first time a field
// moves, and the browser would keep compiling against a shape the server
// stopped sending. These are type-only exports, so nothing of `src/modules/`
// reaches the bundle — the whole file disappears at build time.
//
// What is declared below is only what has no counterpart on the server: the
// envelopes the HTTP layer wraps those shapes in, and the front end's own
// vocabulary (which sheet tab is open).

export type {
  ApprovalState,
  FileContentKind,
  FileRead,
  ItemApproval,
  ItemClosure,
  ItemCost,
  ItemFailure,
  ItemGroup,
  ItemProject,
  ItemStatus,
  ItemStop,
  Launch,
  LaunchRecord,
  ProjectEntry,
  RunEventView,
  RunModelCost,
  RunRecap,
  RunRecapStep,
  RunReport,
  RunReportCaptureGroup,
  RunReportCriterion,
  RunReportDelivered,
  RunReportFollowUp,
  RunReportLink,
  RunReportNote,
  RunReportProof,
  RunReportReview,
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
} from "../../../read-model/index.js";
// An item as the server answers it: the read model's item plus the verbs the
// server decided it admits.
export type { ActionableItem as Item, Verb, VerbAction } from "../../verbs.js";
export type { TerminalInfo } from "../../terminals.js";
export type { ProjectView } from "../../routes/projects.js";

import type { FileRead, ReportRead, RunRecap, RunStepsView, WorkItemTree } from "../../../read-model/index.js";
import type { ProjectView } from "../../routes/projects.js";
import type { TerminalInfo } from "../../terminals.js";
import type { ActionableItem as Item } from "../../verbs.js";

/** `GET /api/me` and `POST /api/me`. `user` is `null` until a name is chosen. */
export interface MeResponse {
  user: string | null;
  users: string[];
  error?: string;
}

/** `GET /api/projects` and `POST /api/projects`. */
export interface ProjectsResponse {
  projects: ProjectView[];
}

/** `GET /api/items`. */
export interface ItemsResponse {
  items: Item[];
}

/** `GET /api/items/<project>/<ticket>`: the reads the sheet shows together.
 *  `tree`, `steps` and `recap` are `null` when the run has none. `report` is
 *  `null` without a valid `report.json` for the current run; `reportError` and
 *  `reportWarnings` come from `ReportRead`. */
export interface ItemDetail extends ReportRead {
  item: Item;
  tree: WorkItemTree | null;
  steps: RunStepsView | null;
  recap: RunRecap | null;
}

/**
 * `GET /api/items/<project>/<ticket>/file`.
 *
 * `html` is present only for a markdown file requested with `render=html`: the
 * server rendered it from an escaped source, and it is the single value in the
 * whole front end that is inserted as markup.
 */
export type FileView = (FileRead & { html?: string }) | { status: "error"; error: string };

/** `GET /api/launches/<id>/log`, plus the id the browser asked for, so a stale
 *  answer can be told apart from the log of the launch now on screen. */
export type LaunchLog =
  | { status: "ok"; id: string; path: string; lines: string[]; truncated: boolean }
  | { status: "not-found"; id: string };

/** `POST /api/actions/<verb>`. */
export interface ActionResponse {
  launch?: Item["launch"];
  error?: string;
  item?: Item;
}

/** `artifacts/assumptions.json`, as the pipelines write it. Nothing validates
 *  this file, so every field is optional and every array is read defensively. */
export interface Assumptions {
  blocking?: { ac?: string; subject?: string; assumed?: string }[];
  requiredInputs?: { path?: string; why?: string }[];
  resolved?: { subject?: string; answer?: string; evidence?: string }[];
}

/** Sheet tabs. `auto` is not a tab: it means "follow the item's state", and is
 *  resolved by `currentSheetTab`. */
export type SheetTab = "diagnostic" | "report" | "run" | "document" | "files";
export type RequestedSheetTab = SheetTab | "auto";

/** `GET /api/projects/<name>/pipelines`. */
export interface PipelinesResponse {
  pipelines: string[];
}

/** `POST /api/runs` and `POST /api/sessions`: the session started (201), or the
 *  one already there (409). */
export interface RunResponse {
  terminal: TerminalInfo;
}

/** `GET /api/terminals`. */
export interface TerminalsResponse {
  terminals: TerminalInfo[];
}
