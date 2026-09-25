// modules/read-model/types.ts
//
// Shapes the dashboard reads. They are deliberately independent from the
// persisted shapes of `src/state`: the read model translates run state into the
// vocabulary of the morning box (item, group, stop, approval), so a change in
// the durable schema never reaches the HTTP layer or the browser.

/** Durable run status, restricted to the values an item can carry. `UNKNOWN` is
 *  read as `RUNNING`: a snapshot that never received a verdict is still, from a
 *  reader's point of view, a run nobody finished. */
export type ItemStatus = "STOPPED" | "FAIL" | "ABORTED" | "RUNNING" | "PASS";

/** Section of the morning box an item belongs to. Technical failures rank with
 *  gates: both wait for the same person. */
export type ItemGroup = "decision" | "failure" | "running" | "done";

/** Expected recovery for a clean stop, as the runner recorded it. */
export type ItemStopKind = "needs-info" | "needs-decision" | "needs-human" | "blocked";

/** Failure kind in the dashboard's words: a judgment call the agent made, or an
 *  incident it hit. The runner persists `verdict` / `technical`. */
export type ItemFailKind = "judgment" | "incident";

/** Why the failure is not worth repairing, when the runner said so. Shown beside
 *  the kind, not folded into it: an incident sends a reader to the logs, a block
 *  sends them to the environment. The runner persists `blocked`. */
export type ItemFailCause = "blocked";

/** Freshness of the approval that lifts the pending gate. `absent` also covers
 *  "not required": the two are indistinguishable on disk. */
export type ApprovalState = "absent" | "fresh" | "stale";

export interface ItemProject {
  /** Last segment of the project path. */
  name: string;
  /** Absolute path of the main clone. */
  cwd: string;
  /** Work-item provider declared in `<cwd>/.lance-nuit/config.json`. */
  provider: string;
  /** Tracker URL of this ticket, when the project declares a base URL. */
  ticketUrl?: string;
}

/** Structured cause of a clean stop. `detail` is always present: a run stopped
 *  before `outcome.stop` existed still carries its raw `stopped_reason`. */
export interface ItemStop {
  subject?: string;
  kind?: ItemStopKind;
  detail: string;
}

export interface ItemFailure {
  phase: string;
  reason: string;
  failKind?: ItemFailKind;
  /** Present when no fix pass could have changed the answer. */
  failCause?: ItemFailCause;
}

export interface ItemApproval {
  subject: string;
  state: ApprovalState;
  decidedAt?: string;
  decidedBy?: string;
}

/** Cost of the run. `usd` is absent when no attempt reported one; `estimated`
 *  says the figure comes from a rate table rather than from the provider. */
export interface ItemCost {
  usd?: number;
  estimated: boolean;
  /** An attempt spent tokens no pricing table could price: `usd` is a LOWER
   *  BOUND, not the run's spend. A reader must never see it as an exact figure,
   *  and `0` least of all — the dashboard prints `≥`. */
  unknown?: boolean;
}

/** A failed or stopped run somebody closed by hand (`lancenuit close`): the
 *  ticket was finished outside lance-nuit. The status is kept; only the group
 *  changes. */
export interface ItemClosure {
  at: string;
  by: string;
}

/** Dashboard record of one verb it triggered, as written to
 *  `~/.lance-nuit/ui/launches/<id>.json` (spec 5.2). `exitCode` is `null` when the
 *  process ended without a code the server could observe — killed, or gone when
 *  the server restarted. */
export interface LaunchRecord {
  /** `<timestamp>-<ticket>-<verb>`. */
  id: string;
  at: string;
  /** Name from the identity cookie. */
  by: string;
  /** Project name, as `Item.project.name`. */
  project: string;
  ticket: string;
  verb: string;
  /** Exact arguments handed to `lancenuit`, without the executable. */
  argv: string[];
  cwd: string;
  pid: number;
  exitCode?: number | null;
  finishedAt?: string;
}

/** A launch as the dashboard shows it: the record plus whether its process still
 *  runs, derived from the pid rather than trusted from the file. */
export interface Launch extends LaunchRecord {
  alive: boolean;
}

/** One work item as the morning box shows it: the latest run of the ticket,
 *  across every pipeline it ran on. */
export interface Item {
  /** `<project>/<ticket>`. */
  key: string;
  project: ItemProject;
  ticket: string;
  pipeline: string;
  runId: string;
  status: ItemStatus;
  group: ItemGroup;
  stop?: ItemStop;
  failure?: ItemFailure;
  approval?: ItemApproval;
  /** The run hit its cost ceiling: the one situation with a verb of its own
   *  (`--budget`, spec 5.1). */
  budgetExceeded?: true;
  /** The run stopped because its spending could no longer be accounted for
   *  against its ceiling. Resumable, but only under an explicit CLI
   *  authorization: the dashboard shows the command, it does not offer a verb
   *  for it — authorizing spend nobody can price is a decision taken at the
   *  terminal, on purpose. */
  costUnaccounted?: true;
  cost: ItemCost;
  /** ISO 8601; the age shown in the list is `now - updatedAt`. */
  updatedAt: string;
  branch?: string;
  /** True when the run executed inside a worktree. */
  worktree: boolean;
  /** Directory whose `artifacts/` and `decisions/` this run reads: the worktree
   *  copy for a worktree run, the main clone otherwise. */
  effectiveWorkItemDir: string;
  /** Latest dashboard launch for this item, when one exists. An alive launch puts
   *  the item in the `running` group whatever `state.json` still says. */
  launch?: Launch;
  /** Present while a hand closure still describes the run: the item is then in
   *  the `done` group whatever its status. */
  closed?: ItemClosure;
}

/** How the dashboard renders a file, derived from its extension alone. `other`
 *  is served as text: a work-item directory holds documents, not binaries. */
export type FileContentKind = "md" | "json" | "png" | "log" | "txt" | "other";

export interface TreeFile {
  kind: "file";
  name: string;
  /** Path relative to the effective work-item directory, POSIX-style. */
  path: string;
  size: number;
  contentKind: FileContentKind;
  /** The artifact the pending gate is waiting on. */
  gate?: true;
  /** The file the dashboard opens when the reader opens the item. */
  defaultOpen?: true;
}

export interface TreeDirectory {
  kind: "directory";
  name: string;
  path: string;
  children: TreeNode[];
}

export type TreeNode = TreeFile | TreeDirectory;

/** The explorer's view of one work item, rooted at the directory the run reads. */
export interface WorkItemTree {
  /** Absolute effective work-item directory. */
  root: string;
  pipeline: string;
  runId: string;
  /** Absolute directory of the run this tree points at. */
  runDir: string;
  children: TreeNode[];
  /** Relative path of the gate artifact, when one was identified. */
  gatePath?: string;
  /** Relative path of the file to open first, when there is one. */
  defaultPath?: string;
}

/** Bounded read of one file. `ok` carries the content, `too-large` carries the
 *  absolute path so the reader opens the file on the disk instead. */
export type FileRead =
  | {
      status: "ok";
      /** Absolute path, also shown as "open on the disk". */
      path: string;
      relativePath: string;
      contentKind: FileContentKind;
      size: number;
      encoding: "text" | "base64";
      content: string;
    }
  | {
      status: "too-large";
      path: string;
      relativePath: string;
      contentKind: FileContentKind;
      size: number;
      /** Cap that was crossed, in bytes. */
      limit: number;
    }
  | { status: "not-found"; relativePath: string }
  | { status: "denied"; relativePath: string; reason: string };

/** Persisted step status, as the run list shows it. */
export type RunStepStatus = "pending" | "running" | "done" | "failed" | "skipped" | "aborted";

export interface RunStepView {
  id: string;
  status: RunStepStatus;
  startedAt?: string;
  finishedAt?: string;
  /** Retries consumed, when the step needed any. */
  retries?: number;
  failKind?: ItemFailKind;
  /** Present when no fix pass could have changed the answer. */
  failCause?: ItemFailCause;
  /** Readable failure reason the runner persisted on a failed step. */
  error?: string;
}

/** Last line of the run journal, for a run still in flight. */
export interface RunEventView {
  type: string;
  at?: string;
  stepId?: string;
}

export interface RunStepsView {
  pipeline: string;
  runId: string;
  /** Absolute run directory. */
  runDir: string;
  status: ItemStatus;
  steps: RunStepView[];
  /** Present only while the run is RUNNING: the snapshot is behind, the journal
   *  is not. */
  lastEvent?: RunEventView;
}
