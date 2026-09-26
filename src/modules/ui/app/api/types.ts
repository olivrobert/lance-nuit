// The shapes the dashboard receives over HTTP.
//
// Every DTO the server already owns is RE-EXPORTED from the read model rather
// than copied here. The read model is the source of truth for what a work item
// is; a second hand-written declaration would drift silently the first time a
// field moves, and the browser would keep compiling against a shape the server
// stopped sending. These are type-only exports, so nothing of `src/modules/`
// reaches the bundle — the whole file disappears at build time.
//
// What is declared below is only what has no counterpart in the read model: the
// envelopes the HTTP layer wraps those shapes in, and the front end's own
// vocabulary (which sheet tab is open).

export type {
  ApprovalState,
  FileContentKind,
  FileRead,
  Item,
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
export type { Verb } from "../../actions.js";

import type {
  FileRead,
  Item,
  ProjectEntry,
  ReportRead,
  RunRecap,
  RunStepsView,
  WorkItemTree,
} from "../../../read-model/index.js";

/** `GET /api/me` and `POST /api/me`. `user` is `null` until a name is chosen. */
export interface MeResponse {
  user: string | null;
  users: string[];
  error?: string;
}

/** `GET /api/projects` and `POST /api/projects`. */
export interface ProjectsResponse {
  projects: ProjectEntry[];
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

/** One action button: the verb posted, its label, and the command the server
 *  will build — shown as the tooltip so the reader can see it before clicking. */
export interface VerbAction {
  verb: string;
  label: string;
  command: string;
  primary?: boolean;
  danger?: boolean;
}

/**
 * One interactive run: a tmux session on the dashboard's own socket, running
 * the reader's shell in the project's main clone. tmux is the authoritative
 * state; the server rebuilds this record from the session's user options.
 * Declared here until the server module that owns it can be re-exported.
 */
export interface TerminalInfo {
  id: string;
  project: string;
  ticket: string;
  pipeline: string;
  worktree: boolean;
  by: string;
  /** ISO timestamp. */
  createdAt: string;
  /** For display only: the `lancenuit run …` line typed into the session. */
  command: string;
  /** The line a reader types to attach from their own terminal. */
  attach: string;
}

/** `GET /api/projects/<name>/pipelines`. */
export interface PipelinesResponse {
  pipelines: string[];
}

/** `POST /api/runs`: the session started (201), or the one already there (409). */
export interface RunResponse {
  terminal: TerminalInfo;
}

/** `GET /api/terminals`. */
export interface TerminalsResponse {
  terminals: TerminalInfo[];
}
