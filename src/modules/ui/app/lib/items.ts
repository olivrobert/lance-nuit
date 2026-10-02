// What one item says about itself: why it is in the box, its headline, and
// the wording of the verbs launched on it.

import type { Item } from "../api/types.js";

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
  "reject-and-rerun": "reject and rework",
  rerun: "rerun",
  fresh: "start fresh",
  budget: "raise budget",
  close: "mark as closed",
  reopen: "reopen",
};

export function verbLabel(verb: string): string {
  return VERB_LABELS[verb] ?? verb;
}

/** A finished run that delivered: `PASS`, in the `done` group, neither closed
 *  by hand nor relaunched. The one case the header calls "Delivered". */
export function isDelivered(item: Item): boolean {
  return item.group === "done" && item.status === "PASS" && !item.closed && item.launch?.alive !== true;
}

/**
 * The CLI line that lifts an accounting stop, for a reader to copy.
 *
 * It is text, never a button: the server deliberately offers no verb for it. A
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

/** An item key is `<project>/<ticket>`, split on the FIRST separator: a project
 *  name never contains one, a ticket token might. */
export function splitKey(key: string): [string, string] {
  const cut = key.indexOf("/");
  if (cut < 0) return [key, ""];
  return [key.slice(0, cut), key.slice(cut + 1)];
}
