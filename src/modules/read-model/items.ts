// modules/read-model/items.ts
//
// The morning box: one item per work item, across every listed project.
//
// A ticket that ran on several pipelines yields ONE item — the most recently
// updated run — because the question the box answers is "what does this ticket
// need from me now", not "what did each pipeline do". The other runs stay
// visible in the explorer (ticket 03).
//
// Every read goes through the state layer's own readers and ports
// (`RunStateStore`, `WorkItemArtifactStore`, `readDecisionAt`, `sha256Text`):
// this module composes them, it never parses `state.json` itself. Nothing is
// cached across calls — a per-call cache is enough for a few dozen work items
// per project, and a persistent one would show a stale morning box.

import { join } from "node:path";
import type { StepFailCause, StepFailKind } from "../../contracts/backends.js";
import { createArtifactRef } from "../../model/artifact-ports.js";
import type { PersistedRun } from "../../model/persisted.js";
import { runProvesUnpricedSpend } from "../../state/cost-accounting.js";
import { isValidSubjectToken, readDecisionAt } from "../../state/decisions.js";
import { sha256Text } from "../../state/hash.js";
import { hasUnfinishedWork } from "../../state/run-predicates.js";
import type { HistoryEntry } from "../../state/stats/history-reader.js";
import { readHistory } from "../../state/stats/history-reader.js";
import { FileRunStateStore } from "../../state/stores/file-run-state-store.js";
import { FileWorkItemArtifactStore } from "../../state/stores/file-work-item-artifact-store.js";
import { latestLaunchByItem } from "./launches.js";
import { type ProjectEntry, type ReadModelOptions, readProjects, ticketUrl } from "./projects.js";
import { effectiveCwd, latestRuns, statusOf, ticketDirectories } from "./runs.js";
import type { Item, ItemApproval, ItemCost, ItemFailure, ItemGroup, ItemStatus, ItemStop, Launch } from "./types.js";

const GROUP_BY_STATUS: Record<ItemStatus, ItemGroup> = {
  STOPPED: "decision",
  FAIL: "failure",
  ABORTED: "failure",
  RUNNING: "running",
  PASS: "done",
};

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

/**
 * A run that hit its cost ceiling.
 *
 * `outcome.stopKind` is the answer of the generation that stopped, and the only
 * one that survives a `--budget` resume wiping `budget_exceeded`. The flag comes
 * next, and the sentence the report printed is the fallback for a snapshot
 * written before either existed.
 */
function budgetExceededOf(state: PersistedRun): boolean {
  if (state.outcome?.stopKind === "budget-exceeded") return true;
  if (state.outcome?.stopKind === "cost-unaccounted") return false;
  if (state.budget_exceeded === true) return true;
  const text = `${state.outcome?.reason ?? ""} ${state.stopped_reason ?? ""}`;
  return /budget exceeded|cost limit/i.test(text);
}

/** A total that is a lower bound (`≥`), whatever the run then did with it: the
 *  run-level latch or the totals themselves say so. Independent of the stop —
 *  an authorized or uncapped run also prints `≥`. */
function costUnknownOf(state: PersistedRun): boolean {
  return state.cost_unaccounted === true || state.total_control?.cost_unknown === true;
}

/**
 * A run that actually STOPPED because its spending stopped being accountable —
 * the only case where the dashboard may print the accounting banner and the
 * `--allow-unmetered` command.
 *
 * Keyed on a real stop, like `budgetExceededOf`: a ceiling to enforce, no human
 * authorization, evidence of unpriceable spend, and work left to do. Without
 * those, an unknown total is only a `≥` on a run nothing withheld anything from —
 * an uncapped run has no ceiling to lose, an authorized one already answered the
 * question, and a finished one has nothing left to withhold. The evidence is the
 * latch, or the attempts of a snapshot written before it existed, or the sentence
 * the report printed for a run older still.
 */
function costUnaccountedOf(state: PersistedRun): boolean {
  if (state.max_cost_usd == null || state.allow_unmetered === true) return false;
  if (!hasUnfinishedWork(state)) return false;
  // The stopping generation's own typed answer, when it wrote one: it also says
  // NO for a run whose ledger is a lower bound but which stopped at its ceiling
  // or failed for its own reason, which the evidence tiers below cannot tell
  // apart.
  if (state.outcome?.stopKind) return state.outcome.stopKind === "cost-unaccounted";
  if (state.cost_unaccounted === true || runProvesUnpricedSpend(state)) return true;
  return /cost unaccounted/i.test(`${state.outcome?.reason ?? ""} ${state.stopped_reason ?? ""}`);
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

/**
 * Structured cause of a clean stop.
 *
 * `outcome.stop` is the current shape; a run stopped before it existed carries
 * only the console sentence of `stopped_reason`, which becomes the detail with
 * no subject and no kind — the reader sees why, and no button claims to know
 * which approval would lift it.
 */
function stopOf(state: PersistedRun): ItemStop {
  const stop = state.outcome?.stop;
  if (stop) {
    return {
      ...(stop.subject ? { subject: stop.subject } : {}),
      ...(stop.kind ? { kind: stop.kind } : {}),
      detail: stop.detail,
    };
  }
  return { detail: state.stopped_reason ?? state.outcome?.reason ?? "" };
}

function failureOf(state: PersistedRun): ItemFailure {
  const failKind = failKindOf(state.outcome?.failKind);
  const failCause = failCauseOf(state.outcome?.failCause);
  return {
    phase: state.outcome?.phase ?? "",
    reason: state.outcome?.reason ?? state.stopped_reason ?? "",
    ...(failKind ? { failKind } : {}),
    ...(failCause ? { failCause } : {}),
  };
}

function costOf(state: PersistedRun): ItemCost {
  const usd = state.total_control?.total_cost_usd;
  return {
    ...(typeof usd === "number" ? { usd } : {}),
    estimated: state.total_control?.cost_estimated === true,
    // The latch counts as much as the totals: a resumed generation can rewrite
    // `total_control` while the run it continues already spent unpriced tokens.
    // Deliberately NOT the stop condition: the `≥` is a property of the figure,
    // and it outlives an authorization that let the run continue.
    ...(costUnknownOf(state) ? { unknown: true } : {}),
  };
}

/**
 * The single pending approval of a stopped run.
 *
 * Gates are sequential, so a stopped run has exactly one. Freshness compares the
 * hash locked in the decision with the artifact as it stands NOW in the
 * effective directory: an artifact rewritten since the approval makes the
 * decision stale, which is precisely what the runner will conclude too.
 */
async function approvalOf(
  project: ProjectEntry,
  ticket: string,
  runCwd: string,
  subject: string,
): Promise<ItemApproval | undefined> {
  // The subject reaches a file path; an invalid one is dropped rather than
  // joined, so a corrupt snapshot cannot steer the read out of `decisions/`.
  if (!isValidSubjectToken(subject)) return undefined;

  const decision = readDecisionAt(join(runCwd, project.specPath, ticket, "decisions", `${subject}.json`));
  if (!decision) return { subject, state: "absent" };

  const store = new FileWorkItemArtifactStore({
    cwd: runCwd,
    config: { specPath: project.specPath },
    ticket,
    ticketDir: ticket,
  });
  let body: string | undefined;
  try {
    body = await store.readText(createArtifactRef(ticket, decision.artifact.slice("artifacts/".length)));
  } catch {
    // An artifact that cannot be read can no longer prove the approval fresh.
    body = undefined;
  }
  const fresh = body !== undefined && sha256Text(body) === decision.artifactSha256;
  return {
    subject,
    state: fresh ? "fresh" : "stale",
    decidedAt: decision.decidedAt,
    decidedBy: decision.decidedBy,
  };
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

async function buildItem(
  project: ProjectEntry,
  ticket: string,
  store: FileRunStateStore,
  cache: RequestCache,
): Promise<Item | undefined> {
  const [selected] = latestRuns(project, ticket, store);
  if (!selected) return undefined;

  const { state } = selected;
  const status = statusOf(state);
  const runId = state.runId ?? "";
  const runCwd = effectiveCwd(project, state);
  const stop = status === "STOPPED" ? stopOf(state) : undefined;
  const approval = stop?.subject ? await approvalOf(project, ticket, runCwd, stop.subject) : undefined;
  const url = ticketUrl(project, ticket);
  const branch = runId ? branchOf(project, runId, cache) : undefined;
  const key = `${project.name}/${ticket}`;
  const launch = cache.launches.get(key);
  // A runner the dashboard just spawned is running before it has written
  // anything: the launch, not the snapshot, is what knows that.
  const group: ItemGroup = launch?.alive ? "running" : GROUP_BY_STATUS[status];

  return {
    key,
    project: {
      name: project.name,
      cwd: project.cwd,
      provider: project.provider,
      ...(url ? { ticketUrl: url } : {}),
    },
    ticket,
    pipeline: selected.pipeline,
    runId,
    status,
    group,
    ...(stop ? { stop } : {}),
    ...(status === "FAIL" || status === "ABORTED" ? { failure: failureOf(state) } : {}),
    ...(approval ? { approval } : {}),
    ...(budgetExceededOf(state) ? { budgetExceeded: true } : {}),
    ...(costUnaccountedOf(state) ? { costUnaccounted: true } : {}),
    cost: costOf(state),
    updatedAt: state.updatedAt ?? state.createdAt ?? "",
    ...(branch ? { branch } : {}),
    worktree: state.worktree === true,
    effectiveWorkItemDir: join(runCwd, project.specPath, ticket),
    ...(launch ? { launch } : {}),
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
  const store = new FileRunStateStore();
  const items: Item[] = [];
  for (const project of readProjects(options)) {
    if (!project.found) continue;
    for (const ticket of ticketDirectories(project)) {
      const item = await buildItem(project, ticket, store, cache);
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
  return buildItem(project, ticket, new FileRunStateStore(), createCache(options));
}
