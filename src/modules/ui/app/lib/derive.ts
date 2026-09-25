// Everything the screen decides from the data, and nothing it draws.
//
// In the DOM version these rules were interleaved with element construction and
// read a module-level `state` object, so none of them could be exercised without
// a document. Here every one of them is a pure function of its arguments: the
// list filter takes the filter, the tab resolver takes the requested tab and the
// detail it has to fall back through. That is what makes them testable, and it
// is the reason the components downstream contain almost no branching.

import type {
  Assumptions,
  Item,
  ItemDetail,
  Queue,
  RequestedSheetTab,
  SheetTab,
  TreeFile,
  TreeNode,
  VerbAction,
  WorkItemTree,
} from "../api/types.js";

/** Reading order of the list, and the heading each group carries. */
export const GROUPS: readonly (readonly [Item["group"], string])[] = [
  ["decision", "Needs decision"],
  ["failure", "Technical failure"],
  ["running", "Running"],
  ["done", "Completed"],
] as const;

/** Groups whose items are counted as "waiting for you". */
export const WAITING: readonly Item["group"][] = ["decision", "failure"];

export function isWaiting(item: Item): boolean {
  return WAITING.includes(item.group);
}

/** One line saying why the item is in the box, in the words of its group. */
export function reasonOf(item: Item): string {
  if (item.launch?.alive) return `launched by ${item.launch.by} (${verbLabel(item.launch.verb)})`;
  if (item.group === "decision") return item.stop ? item.stop.detail : "stopped";
  if (item.group === "failure") {
    if (!item.failure) return item.status === "ABORTED" ? "aborted" : "failed";
    return `${item.failure.phase} — ${item.failure.reason}`;
  }
  if (item.group === "running") return "running";
  if (item.closed) return `closed by ${item.closed.by}`;
  return "completed";
}

export function headlineOf(item: Item): string {
  if (item.group === "failure") {
    if (/timeout/i.test(item.failure?.reason ?? "")) return "Execution timed out";
    if (item.status === "ABORTED") return "Execution interrupted";
    return item.failure?.phase ? `Failed at ${item.failure.phase}` : "Execution failed";
  }
  if (item.group === "running") return "Execution in progress";
  if (item.closed) return "Closed by hand";
  if (item.group === "done") return "Run completed";
  return item.stop?.subject ? `Review ${item.stop.subject}` : "Your input is needed";
}

/** Human wording of the closed verb set. A verb the server grows before the
 *  browser knows about it falls through to its own name rather than vanishing. */
export const VERB_LABELS: Record<string, string> = {
  "approve-and-rerun": "approve and rerun",
  approve: "approve only",
  rerun: "rerun",
  fresh: "start fresh",
  budget: "raise budget",
  close: "mark as closed",
  reopen: "reopen",
};

export function verbLabel(verb: string): string {
  return VERB_LABELS[verb] ?? verb;
}

/** Nothing may be launched on an item whose runner runs, or whose launch of
 *  ours is still alive (spec 5.1). */
export function isBusy(item: Item): boolean {
  return item.status === "RUNNING" || item.launch?.alive === true;
}

/**
 * The closed set of verbs for one item (spec 5.1).
 *
 * The command carried by each entry is what the server will build: the server
 * builds `argv` itself from the item, the browser only names the verb. It is
 * shown as a tooltip so a reader can read the command before running it.
 */
export function verbsFor(item: Item): VerbAction[] {
  const worktree = item.worktree ? " --worktree" : "";
  const base = `lancenuit run ${item.ticket} --pipeline ${item.pipeline}`;
  const verbs: VerbAction[] = [];
  const subject = item.status === "STOPPED" ? item.stop?.subject : undefined;

  // A closed run waits on nobody: the only questions left are to reopen it, or
  // to start over. A plain rerun would reopen it too, but silently.
  if (item.closed) {
    return [
      {
        verb: "reopen",
        label: "Reopen",
        primary: true,
        command: `lancenuit reopen ${item.ticket} --pipeline ${item.pipeline}`,
      },
      { verb: "fresh", label: "Start fresh", danger: true, command: `${base} --fresh${worktree}` },
    ];
  }

  if (item.status === "STOPPED" && subject) {
    verbs.push({
      verb: "approve-and-rerun",
      label: "Approve and rerun",
      primary: true,
      command: `${base} --approve ${subject}${worktree}`,
    });
    verbs.push({
      verb: "approve",
      label: "Approve only",
      command: `lancenuit approve ${item.ticket} ${subject} --pipeline ${item.pipeline}${worktree}`,
    });
  }
  if (item.status === "STOPPED" && !subject) {
    verbs.push({ verb: "rerun", label: "Rerun", primary: true, command: `${base}${worktree}` });
  }
  if (item.status === "FAIL" || item.status === "ABORTED") {
    verbs.push({ verb: "rerun", label: "Rerun from failure", primary: true, command: `${base}${worktree}` });
  }
  if (item.budgetExceeded) {
    verbs.push({ verb: "budget", label: "Raise budget", command: `${base} --budget <usd>${worktree}` });
  }
  if (item.status === "STOPPED" || item.status === "FAIL" || item.status === "ABORTED") {
    verbs.push({
      verb: "close",
      label: "Mark as closed",
      command: `lancenuit close ${item.ticket} --pipeline ${item.pipeline}`,
    });
  }
  if (item.status !== "RUNNING") {
    verbs.push({ verb: "fresh", label: "Start fresh", danger: true, command: `${base} --fresh${worktree}` });
  }
  return verbs;
}

/**
 * The CLI line that lifts an accounting stop, for a reader to copy.
 *
 * It is text, never a button: `verbsFor` deliberately has no verb for it. A
 * dashboard click authorizing spend nobody can price would be a budget decision
 * taken by whoever happened to have the tab open; the terminal is where that
 * decision belongs.
 */
export function unmeteredResumeCommand(item: Item): string {
  const worktree = item.worktree ? " --worktree" : "";
  return `lancenuit run ${item.ticket} --pipeline ${item.pipeline} --allow-unmetered${worktree}`;
}

/**
 * A launch that ended before the run moved: lock held, `bun` missing, refusal of
 * the runner. The run's `updatedAt` is older than the launch, so the failure is
 * the launcher's, and the log is where the reason is (spec 5.2).
 */
export function failedBeforeRun(item: Item): boolean {
  const launch = item.launch;
  if (!launch || launch.alive || launch.exitCode === 0) return false;
  const launchedAt = Date.parse(launch.at);
  const updatedAt = Date.parse(item.updatedAt);
  return Number.isFinite(launchedAt) && (!Number.isFinite(updatedAt) || updatedAt <= launchedAt);
}

/** The tab an item opens on when the reader has expressed no preference. */
export function defaultSheetTab(item: Item): SheetTab {
  if (item.group === "failure") return "diagnostic";
  if (item.group === "running") return "steps";
  if (item.group === "done") return "recap";
  return "document";
}

/**
 * The tab actually shown.
 *
 * A tab whose content does not exist is never rendered empty: it falls back,
 * once, to the item's default — and `document` falls back further, to `files`
 * when there is a tree and to `diagnostic` when there is none. The chain is
 * shallow on purpose; a second-level fallback that could itself fall back would
 * be a loop waiting to happen. `recap` is the one tab placed before that
 * chain: without a recap it reads as a request for `document`, and goes no
 * further than `document` itself would.
 */
export function currentSheetTab(item: Item, detail: ItemDetail | null, requested: RequestedSheetTab): SheetTab {
  const asked = requested === "auto" ? defaultSheetTab(item) : requested;
  const wanted = asked === "recap" && !detail?.recap ? "document" : asked;
  const tree = detail?.tree;
  if (wanted === "document" && !tree?.gatePath && !tree?.defaultPath) return tree ? "files" : "diagnostic";
  if (wanted === "files" && !tree) return defaultSheetTab(item);
  if (wanted === "steps" && !detail?.steps) return defaultSheetTab(item);
  if (wanted === "diagnostic" && item.group !== "failure" && !item.launch) return defaultSheetTab(item);
  return wanted;
}

/** What the sidebar filters on: a project chip, a queue, and the search box. */
export interface ItemFilters {
  filter: string | null;
  queue: Queue;
  query: string;
}

/** The rows the list shows. The three filters are cumulative, and the search
 *  matches the same four fields the row itself displays. */
export function visibleItems(items: readonly Item[], filters: ItemFilters): Item[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (filters.filter && item.project.name !== filters.filter) return false;
    if (filters.queue === "attention" && !isWaiting(item)) return false;
    if (filters.queue === "running" && item.group !== "running") return false;
    if (filters.queue === "done" && item.group !== "done") return false;
    if (!query) return true;
    return [item.ticket, item.pipeline, item.project.name, reasonOf(item)]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(query));
  });
}

/** Size of one queue, over every project: the counts on the queue buttons are
 *  deliberately NOT narrowed by the project chip, so switching project never
 *  makes a queue look empty when it is not. */
export function queueCount(items: readonly Item[], queue: Queue): number {
  return items.filter((item) => {
    if (queue === "attention") return isWaiting(item);
    if (queue === "running") return item.group === "running";
    return item.group === "done";
  }).length;
}

/** Items waiting for a decision, for one project or for all of them. */
export function waitingCount(items: readonly Item[], projectName: string | null): number {
  return items.filter((item) => (!projectName || item.project.name === projectName) && isWaiting(item)).length;
}

export function countFiles(node: TreeNode): number {
  return node.kind === "file" ? 1 : node.children.reduce((total, child) => total + countFiles(child), 0);
}

/** The first `assumptions.json` anywhere in the tree. Depth-first, and the first
 *  hit wins: a run writes one, and a second would be a copy. */
export function findAssumptions(nodes: readonly TreeNode[]): TreeFile | undefined {
  for (const node of nodes) {
    if (node.kind === "file" && node.name === "assumptions.json") return node;
    if (node.kind === "directory") {
      const found = findAssumptions(node.children);
      if (found) return found;
    }
  }
  return undefined;
}

/** True when `assumptions.json` holds anything worth a section. */
export function hasAssumptionContent(data: Assumptions | null): boolean {
  if (!data) return false;
  return [data.blocking, data.requiredInputs, data.resolved].some(
    (entries) => Array.isArray(entries) && entries.length > 0,
  );
}

/** An item key is `<project>/<ticket>`, split on the FIRST separator: a project
 *  name never contains one, a ticket token might. */
export function splitKey(key: string): [string, string] {
  const cut = key.indexOf("/");
  if (cut < 0) return [key, ""];
  return [key.slice(0, cut), key.slice(cut + 1)];
}

/** MIME type of an image the explorer shows inline. The read model already
 *  refused anything that is not an image, so PNG is a safe default. */
export function mimeOf(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

/** The images of one directory of `reports/`, with the summary a browser step
 *  left beside them, when it left one. */
export interface ScreenshotGroup {
  dir: string;
  images: TreeFile[];
  summary?: TreeFile;
}

/** Names a browser step gives the table that explains its screenshots. A
 *  convention of the pipelines, not a contract: a directory without one simply
 *  shows its images. */
const SUMMARY_NAMES: readonly string[] = ["summary.md", "report.md"];

function collectScreenshots(node: TreeNode, groups: ScreenshotGroup[]): void {
  if (node.kind === "file") return;
  const images = node.children.filter(
    (child): child is TreeFile => child.kind === "file" && child.contentKind === "png",
  );
  if (images.length > 0) {
    const summary = node.children.find(
      (child): child is TreeFile => child.kind === "file" && SUMMARY_NAMES.includes(child.name.toLowerCase()),
    );
    groups.push({ dir: node.path, images, ...(summary ? { summary } : {}) });
  }
  for (const child of node.children) collectScreenshots(child, groups);
}

/**
 * Screenshots of a run, grouped by the directory that holds them, in tree order.
 *
 * Only `reports/` is searched: it is where the pipelines put what a step
 * produced as evidence, whereas an image under `artifacts/` is an input — a
 * mock-up attached to the ticket — and would pass for a result of the run.
 */
export function screenshotGroups(tree: WorkItemTree | null): ScreenshotGroup[] {
  const reports = tree?.children.find((node) => node.kind === "directory" && node.name === "reports");
  const groups: ScreenshotGroup[] = [];
  if (reports) collectScreenshots(reports, groups);
  return groups;
}
