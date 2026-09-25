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
// vocabulary (which sheet tab is open, which queue is selected).

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
  RunStepStatus,
  RunStepsView,
  RunStepView,
  TreeDirectory,
  TreeFile,
  TreeNode,
  WorkItemTree,
} from "../../../read-model/index.js";
export type { Verb } from "../../actions.js";

import type { FileRead, Item, ProjectEntry, RunStepsView, WorkItemTree } from "../../../read-model/index.js";

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

/** `GET /api/items/<project>/<ticket>`: the three reads the sheet shows
 *  together. `tree` and `steps` are `null` when the run has neither. */
export interface ItemDetail {
  item: Item;
  tree: WorkItemTree | null;
  steps: RunStepsView | null;
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

/** Coarse view the sidebar filters on. */
export type Queue = "attention" | "running" | "done";

/** Sheet tabs. `auto` is not a tab: it means "follow the item's state", and is
 *  resolved by `currentSheetTab`. */
export type SheetTab = "diagnostic" | "steps" | "document" | "files";
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
