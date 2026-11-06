//
// The morning box: one item per work item, across every listed project.
//
// A ticket that ran on several pipelines yields ONE item — the most recently
// updated run — because the question the box answers is "what does this ticket
// need from me now", not "what did each pipeline do". The other runs stay
// visible in the explorer (ticket 03).
//
// Every read goes through the runner's own readers: the run record's `readRun`
// and `readRunHistory`, the work-item store's `WorkItemArtifactStore` and
// `gateDecisionStatus`. This module composes them, it never parses `state.json`
// or the journal itself. Nothing is
// cached across calls — a per-call cache is enough for a few dozen work items
// per project, and a persistent one would show a stale morning box.

import { closeSync, openSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import type { StepFailCause, StepFailKind } from "../../contracts/backends.js";
import type { PersistedRun } from "../../run/index.js";
import {
  awaitsHuman,
  hasVerdict,
  isCompleted,
  isFailure,
  lastPassInterrupted,
  owesWork,
  type RunHistory,
  readRunHistory,
  runSpend,
  type HistoryEntry,
  readHistory,
} from "../../run/index.js";
import { itemCost } from "./cost.js";
import { workItemLayout } from "../../work-items/index.js";
import { latestLaunchByItem } from "./launches.js";
import { type ProjectEntry, type ReadModelOptions, readProjects, ticketUrl } from "./projects.js";
import {
  approvalOf,
  budgetExceededOf,
  closureOf,
  costUnaccountedOf,
  failureOf,
  type RunFailure,
  type RunStop,
  stopOf,
} from "./run-facts.js";
import { effectiveCwd, latestRuns, ticketDirectories, workItemDirOf } from "./runs.js";
import type { Item, ItemCost, ItemFailure, ItemGroup, ItemStatus, Launch } from "./types.js";

/** The box an item sits in, from what its status means: a verdict that is
 *  neither a failure nor a completion waits on a decision. */
function groupOf(status: ItemStatus): ItemGroup {
  if (isFailure(status)) return "failure";
  if (isCompleted(status)) return "done";
  return hasVerdict(status) ? "decision" : "running";
}

/** Reading order of the morning box: what waits for a decision first, what is
 *  merely finished last. */
export const GROUP_ORDER: readonly ItemGroup[] = ["decision", "failure", "running", "done"];

/** Per-call memory. The history file and the launch directory are the reads
 *  shared by every item, so reading each once per call is the whole point. */
interface RequestCache {
  history: Map<string, HistoryEntry[]>;
  launches: Map<string, Launch>;
}

function createCache(options: ReadModelOptions): RequestCache {
  return { history: new Map(), launches: latestLaunchByItem(options) };
}

/** The runner's failure kinds in the dashboard's words. */
function failKindOf(kind: StepFailKind | undefined): ItemFailure["failKind"] {
  if (kind === "verdict") return "judgment";
  if (kind === "technical") return "incident";
  return undefined;
}

/** A cause nothing can repair, reported beside the kind rather than folded into
 *  it: an incident sends a reader to the logs, a block to the environment. */
function failCauseOf(cause: StepFailCause | undefined): ItemFailure["failCause"] {
  return cause === "blocked" ? "blocked" : undefined;
}

/** A failure as the morning box shows it. */
function itemFailureOf(failure: RunFailure): ItemFailure {
  const failKind = failKindOf(failure.kind);
  const failCause = failCauseOf(failure.cause);
  return {
    phase: failure.phase,
    reason: failure.reason,
    ...(failKind ? { failKind } : {}),
    ...(failCause ? { failCause } : {}),
  };
}

/**
 * The step whose last attempt the runner died in, which only a run authorized
 * with `--replay-interrupted` replays.
 *
 * Two situations, both read from the journal because `state.json` keeps no
 * attempt: a crashed run not resumed yet, whose attempt is still open; and a run
 * a plain resume settled then stopped on that attempt (`step-admission.ts`), a
 * stop with no subject. Any other run cannot be in either, so its journal is not
 * read at all.
 */
function interruptedStepOf(
  runDir: string,
  state: PersistedRun,
  interrupted: boolean,
  stop: RunStop | undefined,
): string | undefined {
  if (!interrupted && !(stop && !stop.subject)) return undefined;
  let attemptsByStep: RunHistory["attempts"];
  try {
    attemptsByStep = readRunHistory(runDir).attempts;
  } catch {
    // An unreadable journal only loses the replay offer: the item keeps the
    // verbs it would have had without it.
    return undefined;
  }
  const step = state.steps.find((candidate) => {
    const attempts = attemptsByStep.get(candidate.id);
    if (lastPassInterrupted({ status: candidate.status, attempts })) return true;
    return interrupted && owesWork(candidate.status) && attempts?.at(-1)?.status === "running";
  });
  return step?.id;
}

function costOf(state: PersistedRun): ItemCost {
  // Deliberately NOT the stop condition: the `≥` is a property of the figure,
  // and it outlives an authorization that let the run continue.
  return itemCost(runSpend(state));
}

/** Branch of the run, as the central history recorded it at finalization. */
function branchOf(project: ProjectEntry, runId: string, cache: RequestCache): string | undefined {
  let entries = cache.history.get(project.cwd);
  if (!entries) {
    entries = readHistory(project.cwd);
    cache.history.set(project.cwd, entries);
  }
  const branch = entries.find((entry) => entry.runId === runId)?.branch;
  return typeof branch === "string" && branch.length > 0 ? branch : undefined;
}

/**
 * The pipeline a relaunch must load: the file the run was launched with.
 *
 * Resolved to an absolute path because the snapshot records it relative to the
 * runner's cwd — the worktree for a `--worktree` run — while the dashboard
 * spawns its relaunch in the main clone. Never the name when a file was
 * recorded: the kit would resolve it to another file, or a homonym.
 */
function pipelineRefOf(project: ProjectEntry, state: PersistedRun, name: string): string {
  const recorded = state.pipeline_path;
  return typeof recorded === "string" && recorded.length > 0 ? resolve(effectiveCwd(project, state), recorded) : name;
}

/** Bytes of `ticket.md` read for the title. The heading sits at the top; the
 *  rest of the file can hold a long comment thread nobody needs for a row. */
const TICKET_TITLE_READ_BYTES = 8 * 1024;

/**
 * The ticket title in `artifacts/ticket.md`: the first `# ` heading after an
 * optional leading `---` front matter block, trimmed. A leading `<ticket> — `
 * (or `-`, `–`, `:`) is dropped when `ticket` is given: the dashboard shows the
 * key on its own line, and some providers write it into the heading. `undefined`
 * when there is no such heading, when it is empty, or when the front matter
 * never closes.
 */
export function titleOfTicketMarkdown(text: string, ticket?: string): string | undefined {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end === -1) return undefined;
    start = end + 1;
  }
  const heading = lines.slice(start).find((line) => line.startsWith("# "));
  const title = heading?.slice(2).trim();
  const rest = title && ticket ? withoutTicketPrefix(title, ticket) : title;
  return rest ? rest : undefined;
}

/** `title` without a leading `<ticket>` and its separator; `title` itself when
 *  it does not start with the key followed by a separator. */
function withoutTicketPrefix(title: string, ticket: string): string {
  if (!title.startsWith(ticket)) return title;
  const match = /^\s*[—–:-]\s*/.exec(title.slice(ticket.length));
  return match ? title.slice(ticket.length + match[0].length).trim() : title;
}

/**
 * The first bytes of the work item's `artifacts/ticket.md`, complete lines only.
 *
 * Bounded on purpose: the title is at the top and the list reads one file per
 * item on every poll. When the read is cut, the last line may be partial (even
 * mid-character), so it is dropped rather than shown truncated.
 */
function readTicketHead(workItemDir: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(join(workItemLayout(workItemDir).artifactsDir, "ticket.md"), "r");
    const buffer = Buffer.alloc(TICKET_TITLE_READ_BYTES);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read).toString("utf8");
    return read < buffer.length ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  } catch {
    // No ticket.md (a pipeline without a work-item source step, or a custom
    // `dir`) or an unreadable one: the row falls back to the ticket key.
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing left to read from a descriptor that will not close.
      }
    }
  }
}

/** The ticket title of the work item in `workItemDir`, or `undefined` when its
 *  `ticket.md` is missing or has no heading. */
export function readTicketTitle(workItemDir: string, ticket: string): string | undefined {
  const head = readTicketHead(workItemDir);
  return head === undefined ? undefined : titleOfTicketMarkdown(head, ticket);
}

async function buildItem(project: ProjectEntry, ticket: string, cache: RequestCache): Promise<Item | undefined> {
  const [selected] = latestRuns(project, ticket);
  if (!selected) return undefined;

  const { state, status, interrupted } = selected;
  const runId = state.runId ?? "";
  const stop = stopOf(state, status);
  const failure = failureOf(state, status, interrupted);
  const interruptedStep = interruptedStepOf(selected.runDir, state, interrupted, stop);
  const approval = stop?.subject ? await approvalOf(project, ticket, stop.subject) : undefined;
  const url = ticketUrl(project, ticket);
  const branch = runId ? branchOf(project, runId, cache) : undefined;
  const key = `${project.name}/${ticket}`;
  const launch = cache.launches.get(key);
  const closed = closureOf(selected.runDir, state, status);
  // A runner the dashboard just spawned is running before it has written
  // anything: the launch, not the snapshot, is what knows that. A closed run
  // waits on nobody, whatever its status says.
  const title = readTicketTitle(workItemDirOf(project, ticket), ticket);
  const group: ItemGroup = launch?.alive ? "running" : closed ? "done" : groupOf(status);

  return {
    key,
    project: {
      name: project.name,
      cwd: project.cwd,
      provider: project.provider,
      ...(url ? { ticketUrl: url } : {}),
    },
    ticket,
    ...(title ? { title } : {}),
    pipeline: selected.pipeline,
    pipelineRef: pipelineRefOf(project, state, selected.pipeline),
    runId,
    status,
    group,
    awaitsHuman: awaitsHuman(status),
    ...(stop ? { stop } : {}),
    ...(failure ? { failure: itemFailureOf(failure) } : {}),
    ...(approval ? { approval } : {}),
    ...(budgetExceededOf(state) ? { budgetExceeded: true } : {}),
    ...(costUnaccountedOf(state) ? { costUnaccounted: true } : {}),
    cost: costOf(state),
    updatedAt: state.updatedAt ?? state.createdAt ?? "",
    ...(branch ? { branch } : {}),
    worktree: state.worktree === true,
    ...(launch ? { launch } : {}),
    ...(closed ? { closed } : {}),
    ...(interrupted ? { interrupted: true } : {}),
    ...(interruptedStep ? { interruptedStep } : {}),
  };
}

/** Group first, then most recently updated: the order the morning box renders. */
function compareItems(a: Item, b: Item): number {
  const rank = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
  if (rank !== 0) return rank;
  const age = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  return Number.isFinite(age) && age !== 0 ? age : a.key.localeCompare(b.key);
}

/** Every item of every listed project. A project whose path disappeared
 *  contributes nothing and does not interrupt the others. */
export async function listItems(options: ReadModelOptions = {}): Promise<Item[]> {
  const cache = createCache(options);
  const items: Item[] = [];
  for (const project of readProjects(options)) {
    if (!project.found) continue;
    for (const ticket of ticketDirectories(project)) {
      const item = await buildItem(project, ticket, cache);
      if (item) items.push(item);
    }
  }
  return items.sort(compareItems);
}

/** One item by project name and ticket, or `undefined` when the project is not
 *  listed, the path is gone, or the work item has no run. */
export async function readItem(
  projectName: string,
  ticket: string,
  options: ReadModelOptions = {},
): Promise<Item | undefined> {
  const project = readProjects(options).find((entry) => entry.name === projectName && entry.found);
  if (!project || !ticketDirectories(project).includes(ticket)) return undefined;
  return buildItem(project, ticket, createCache(options));
}
