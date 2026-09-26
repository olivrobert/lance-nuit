// modules/read-model/stats.ts
//
// What every ticket cost, across every listed project: one row per ticket,
// summed over its ROOT runs.
//
// Two rules keep the sums honest. A run is read once, by its real path: the
// `latest` link of a pipeline points at a run that is also listed under its own
// id, and following both would count it twice. And only a run without a
// `parentRunId` is summed: a composed child's spend is already inside its
// parent's `total_control`, the ledger the budget was enforced against.
//
// The figures themselves are the runner's own — `total_control`, never a sum
// recomputed here. Runs written before the current layout are not parsed at
// all: an export script outside the product normalizes them once into
// `~/.lance-nuit/ui/stats-archive.json`, and this file only merges that list,
// preferring the live snapshot of any run that appears in both.
//
// Which tickets are bugs and which are features is the user's vocabulary, not
// the runner's: `~/.lance-nuit/ui/stats.json` maps pipeline names and artifact
// files to a kind. Without it every ticket is `other`. The same file lists the
// pipelines that deliver a ticket — as opposed to one that only triages it — and
// the most recent run of one of those is how the ticket ended. It also lists the
// steps that ship the work, such as pushing a merge request: a ticket passes
// once a run reached one of them, and a delivery run that passed without
// shipping anything is no success. Reaching it is enough — a shipping step that
// failed failed on the handover (a revoked token, a locked git config), after
// the work itself was finished.

import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { asFiniteNumber, asRecord } from "../../lib/json-values.js";
import type { PersistedRun } from "../../model/persisted.js";
import { runProvesUnpricedSpend } from "../../state/cost-accounting.js";
import { FileRunStateStore } from "../../state/stores/file-run-state-store.js";
import { type ProjectEntry, type ReadModelOptions, readProjects, ticketUrl, uiDir, workItemsRoot } from "./projects.js";
import { directoryNames, effectiveCwd, statusOf, ticketDirectories } from "./runs.js";
import { isTicketToken } from "./tickets.js";
import type {
  ItemStatus,
  StatsArchiveState,
  StatsRead,
  StatsRun,
  StatsSource,
  StatsTicket,
  StatsHandover,
  TicketKind,
  TicketOutcome,
} from "./types.js";

/** Classification rules, in `~/.lance-nuit/ui/stats.json`. */
export const STATS_CONFIG_FILE = "stats.json";

/** Normalized runs of the old layouts, written by an export script. */
export const STATS_ARCHIVE_FILE = "stats-archive.json";

/** An artifact read to classify a ticket stays small: a kind, a triage verdict. */
const ARTIFACT_READ_LIMIT_BYTES = 64 * 1024;

/**
 * One artifact rule of `stats.json`.
 *
 * - `{ file, kind }`: the file exists, the ticket is `kind`.
 * - `{ file, field }`: the file is JSON, its top-level `field` names the kind.
 * - `{ file }`: the file's trimmed text names the kind.
 */
interface ArtifactRule {
  file: string;
  field?: string;
  kind?: TicketKind;
}

interface KindRules {
  pipelines: Record<string, TicketKind>;
  artifacts: ArtifactRule[];
}

/**
 * `delivery` of `stats.json`. `pipelines`: those whose most recent run is the
 * ticket's outcome, `null` for all. `steps`: the step ids that ship the work,
 * `null` when a passing run is enough.
 */
interface DeliveryRule {
  pipelines: ReadonlySet<string> | null;
  steps: ReadonlySet<string> | null;
}

type JsonRead = { status: "absent" } | { status: "ok"; value: unknown } | { status: "invalid"; error: string };

function readJson(path: string | null): JsonRead {
  if (!path) return { status: "absent" };
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    // An optional file: no rules, no archive, and the screen still renders.
    return { status: "absent" };
  }
  try {
    return { status: "ok", value: JSON.parse(text) };
  } catch (error) {
    return { status: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}

function uiFile(name: string, options: ReadModelOptions): string | null {
  const dir = uiDir(options.env ?? process.env);
  return dir ? join(dir, name) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A classification word the screen knows, or `undefined` for anything else —
 *  `auto`, a typo, a word from another vocabulary — so the next rule decides. */
function kindOf(value: unknown): TicketKind | undefined {
  const word = typeof value === "string" ? value.trim().toLowerCase() : "";
  return word === "bug" || word === "feature" || word === "other" ? word : undefined;
}

function parseKindRules(value: unknown): KindRules {
  const root = asRecord(asRecord(value)?.kinds);
  const pipelines: Record<string, TicketKind> = {};
  for (const [name, kind] of Object.entries(asRecord(root?.pipelines) ?? {})) {
    const parsed = kindOf(kind);
    if (parsed) pipelines[name] = parsed;
  }
  const artifacts: ArtifactRule[] = [];
  for (const entry of Array.isArray(root?.artifacts) ? root.artifacts : []) {
    const rule = asRecord(entry);
    const file = text(rule?.file);
    // A rule naming a path is dropped: rules come from a hand-edited file, and a
    // `..` in it must not turn classification into a read anywhere on disk.
    if (!file || !isTicketToken(file)) continue;
    const field = text(rule?.field);
    const kind = kindOf(rule?.kind);
    artifacts.push({ file, ...(field ? { field } : {}), ...(kind ? { kind } : {}) });
  }
  return { pipelines, artifacts };
}

/** A missing or empty list is no rule. */
function nameSet(list: unknown): ReadonlySet<string> | null {
  const names = Array.isArray(list) ? list.map(text).filter((name): name is string => name !== undefined) : [];
  return names.length > 0 ? new Set(names) : null;
}

function parseDelivery(value: unknown): DeliveryRule {
  const delivery = asRecord(asRecord(value)?.delivery);
  return { pipelines: nameSet(delivery?.pipelines), steps: nameSet(delivery?.steps) };
}

/** A composed pipeline prefixes its steps (`delivery.create-mr`): the rule
 *  names the step, wherever the pipeline nests it. */
function isShippingStep(id: string, steps: ReadonlySet<string>): boolean {
  return steps.has(id) || steps.has(id.slice(id.lastIndexOf(".") + 1));
}

/** `shipped` when a shipping step completed, else `failed` when one ran and
 *  failed; a skipped or pending one was never reached. */
function handoverOf(state: PersistedRun, steps: ReadonlySet<string> | null): StatsHandover | undefined {
  if (steps === null || !Array.isArray(state.steps)) return undefined;
  const reached = state.steps.filter((step) => isShippingStep(step.id, steps)).map((step) => step.status);
  if (reached.includes("done")) return "shipped";
  return reached.includes("failed") ? "failed" : undefined;
}

function archiveHandoverOf(value: unknown): StatsHandover | undefined {
  return value === "shipped" || value === "failed" ? value : undefined;
}

function readArtifact(workItemDir: string, file: string): string | undefined {
  try {
    const body = readFileSync(join(workItemDir, "artifacts", file));
    return body.length <= ARTIFACT_READ_LIMIT_BYTES ? body.toString("utf-8") : undefined;
  } catch {
    // Absent is the common case: most rules match only some pipelines.
    return undefined;
  }
}

function kindFromArtifact(rule: ArtifactRule, body: string): TicketKind | undefined {
  if (rule.kind) return rule.kind;
  if (!rule.field) return kindOf(body);
  try {
    return kindOf(asRecord(JSON.parse(body))?.[rule.field]);
  } catch {
    // A half-written or foreign JSON file classifies nothing.
    return undefined;
  }
}

function kindFromArtifacts(rules: KindRules, workItemDirs: readonly string[]): TicketKind | undefined {
  for (const rule of rules.artifacts) {
    for (const dir of workItemDirs) {
      const body = readArtifact(dir, rule.file);
      const kind = body === undefined ? undefined : kindFromArtifact(rule, body);
      if (kind) return kind;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** A run on its way to a ticket row: the view, plus what classification needs. */
interface CollectedRun {
  project: string;
  ticket: string;
  run: StatsRun;
  /** Kind the archive recorded; live runs are classified from their artifacts. */
  archivedKind?: TicketKind;
  /** Work-item directories to read classification artifacts from, in order. */
  workItemDirs: readonly string[];
}

function realPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    // A run directory that vanished mid-scan has nothing left to count.
    return null;
  }
}

function costUnknownOf(state: PersistedRun): boolean {
  return state.cost_unaccounted === true || state.total_control?.cost_unknown === true || runProvesUnpricedSpend(state);
}

/** The figures of a run, live or archived, before they are checked. */
interface RunFigures {
  costUsd: unknown;
  costEstimated: boolean;
  costUnknown: boolean;
  activeMs: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  handover: StatsHandover | undefined;
}

/** A run view from figures of either source: a figure that is not a usable
 *  number or stamp is left out rather than shown as zero. */
function statsRun(identity: Pick<StatsRun, "runId" | "pipeline" | "status" | "source">, figures: RunFigures): StatsRun {
  const cost = asFiniteNumber(figures.costUsd);
  const activeMs = asFiniteNumber(figures.activeMs);
  const createdAt = text(figures.createdAt);
  const updatedAt = text(figures.updatedAt);
  const { handover } = figures;
  return {
    ...identity,
    ...(cost !== undefined ? { costUsd: cost } : {}),
    ...(figures.costEstimated ? { costEstimated: true } : {}),
    ...(figures.costUnknown ? { costUnknown: true } : {}),
    ...(activeMs !== undefined && activeMs >= 0 ? { activeMs } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(handover ? { handover } : {}),
  };
}

function liveRunView(pipeline: string, state: PersistedRun, steps: ReadonlySet<string> | null): StatsRun {
  // The ledger's totals, never a sum of the steps: a run without them reports
  // no figure rather than one that disagrees with what its budget was held to.
  const control = state.total_control;
  return statsRun(
    { runId: state.runId ?? "", pipeline: state.pipeline || pipeline, status: statusOf(state), source: "live" },
    {
      costUsd: control?.total_cost_usd,
      costEstimated: control?.cost_estimated === true,
      costUnknown: costUnknownOf(state),
      activeMs: control?.duration_ms,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      handover: handoverOf(state, steps),
    },
  );
}

/**
 * The ticket a run belongs to: the one it recorded, when that is a plain token,
 * else the folder it sits in. The recorded one wins because a folder renamed
 * aside — an archived attempt kept next to the ticket — still holds runs of
 * that same ticket.
 */
function ticketOfRun(folder: string, state: PersistedRun): string {
  return isTicketToken(state.ticket) ? state.ticket : folder;
}

/** Every root run of one project, each read once. */
function liveRuns(project: ProjectEntry, store: FileRunStateStore, steps: ReadonlySet<string> | null): CollectedRun[] {
  const seen = new Set<string>();
  const collected: CollectedRun[] = [];
  const root = workItemsRoot(project);
  for (const folder of ticketDirectories(project)) {
    const runsDir = join(root, folder, "runs");
    for (const pipeline of directoryNames(runsDir)) {
      for (const runName of directoryNames(join(runsDir, pipeline))) {
        const runDir = realPath(join(runsDir, pipeline, runName));
        if (!runDir || seen.has(runDir)) continue;
        seen.add(runDir);
        const state = store.readAt(runDir);
        if (!state || text(state.parentRunId)) continue;

        collected.push({
          project: project.name,
          ticket: ticketOfRun(folder, state),
          run: liveRunView(pipeline, state, steps),
          // The worktree copy first: that is where the run wrote its artifacts.
          // The main clone next, for a worktree removed once merged.
          workItemDirs: [join(effectiveCwd(project, state), project.specPath, folder), join(root, folder)],
        });
      }
    }
  }
  return collected;
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

function archiveStatusOf(value: unknown): ItemStatus {
  switch (value) {
    case "PASS":
    case "FAIL":
    case "STOPPED":
    case "ABORTED":
    case "RUNNING":
      return value;
    default:
      return "RUNNING";
  }
}

function archivedRun(value: unknown): CollectedRun | undefined {
  const entry = asRecord(value);
  const project = text(entry?.project);
  const ticket = text(entry?.ticket);
  const runId = text(entry?.runId);
  if (!entry || !project || !ticket || !runId) return undefined;
  const kind = kindOf(entry.kind);
  return {
    project,
    ticket,
    ...(kind ? { archivedKind: kind } : {}),
    workItemDirs: [],
    run: statsRun(
      { runId, pipeline: text(entry.pipeline) ?? "", status: archiveStatusOf(entry.status), source: "archive" },
      {
        costUsd: entry.costUsd,
        costEstimated: entry.costEstimated === true,
        costUnknown: entry.costUnknown === true,
        activeMs: entry.activeMs,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        // The export script applies the same shipping steps to the old layouts.
        handover: archiveHandoverOf(entry.handover),
      },
    ),
  };
}

function readArchive(options: ReadModelOptions): { state: StatsArchiveState; runs: CollectedRun[] } {
  const read = readJson(uiFile(STATS_ARCHIVE_FILE, options));
  if (read.status === "absent") return { state: { status: "absent" }, runs: [] };
  if (read.status === "invalid") return { state: read, runs: [] };
  const root = asRecord(read.value);
  if (root?.version !== 1 || !Array.isArray(root.runs)) {
    return { state: { status: "invalid", error: "expected { version: 1, runs: [...] }" }, runs: [] };
  }
  const runs = root.runs.map(archivedRun).filter((run): run is CollectedRun => run !== undefined);
  const generatedAt = text(root.generatedAt);
  return { state: { status: "ok", runs: runs.length, ...(generatedAt ? { generatedAt } : {}) }, runs };
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

function stampMs(stamp: string | undefined): number {
  const parsed = stamp ? Date.parse(stamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function recency(run: StatsRun): number {
  return stampMs(run.updatedAt ?? run.createdAt);
}

function sumOf(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? present.reduce((total, value) => total + value, 0) : undefined;
}

function earliest(stamps: readonly (string | undefined)[]): string | undefined {
  return stamps.filter((stamp) => stampMs(stamp) > 0).sort((a, b) => stampMs(a) - stampMs(b))[0];
}

function latest(stamps: readonly (string | undefined)[]): string | undefined {
  return stamps.filter((stamp) => stampMs(stamp) > 0).sort((a, b) => stampMs(b) - stampMs(a))[0];
}

function sourceOf(runs: readonly StatsRun[]): StatsSource | "mixed" {
  const live = runs.some((run) => run.source === "live");
  const archive = runs.some((run) => run.source === "archive");
  return live && archive ? "mixed" : live ? "live" : "archive";
}

/**
 * The ticket's kind, first rule that answers: an artifact the run wrote, then
 * the pipeline of its most recent classified run, then the kind the archive
 * recorded. A ticket triaged by one pipeline and fixed by another takes the
 * fixing pipeline's kind, because `other` never wins over a real answer.
 */
function ticketKind(
  rules: KindRules,
  newestFirst: readonly CollectedRun[],
  workItemDirs: readonly string[],
): TicketKind {
  const fromArtifacts = kindFromArtifacts(rules, workItemDirs);
  if (fromArtifacts && fromArtifacts !== "other") return fromArtifacts;
  for (const { run } of newestFirst) {
    const kind = rules.pipelines[run.pipeline];
    if (kind && kind !== "other") return kind;
  }
  for (const { archivedKind } of newestFirst) {
    if (archivedKind && archivedKind !== "other") return archivedKind;
  }
  return "other";
}

/**
 * A ticket passes once a run reached its handover, whatever came after: the
 * work was finished, even when pushing it failed. Otherwise its most recent
 * delivery run decides, and when shipping is the rule a pass that shipped
 * nothing — a skipped merge request, a pipeline that stopped short of it — is
 * `UNSHIPPED`.
 */
function outcomeOf(runs: readonly StatsRun[], delivery: DeliveryRule): TicketOutcome | undefined {
  if (delivery.steps !== null && runs.some((run) => run.handover)) return "PASS";
  const status = runs.find((run) => run.delivery)?.status;
  return status === "PASS" && delivery.steps !== null ? "UNSHIPPED" : status;
}

function buildTicket(
  key: string,
  collected: readonly CollectedRun[],
  rules: KindRules,
  delivery: DeliveryRule,
  projects: ReadonlyMap<string, ProjectEntry>,
): StatsTicket {
  // Scan order, not recency: the worktree of a run before the main clone.
  const workItemDirs = [...new Set(collected.flatMap((entry) => entry.workItemDirs))];
  const newestFirst = [...collected].sort((a, b) => recency(b.run) - recency(a.run));
  const runs = newestFirst.map(({ run }) =>
    delivery.pipelines === null || delivery.pipelines.has(run.pipeline) || run.handover
      ? { ...run, delivery: true as const }
      : run,
  );
  const outcome = outcomeOf(runs, delivery);
  const [first] = newestFirst;
  const project = first?.project ?? "";
  const ticket = first?.ticket ?? "";
  const entry = projects.get(project);
  const url = entry ? ticketUrl(entry, ticket) : undefined;
  const cost = sumOf(runs.map((run) => run.costUsd));
  const activeMs = sumOf(runs.map((run) => run.activeMs));
  const firstAt = earliest(runs.map((run) => run.createdAt ?? run.updatedAt));
  const lastAt = latest(runs.map((run) => run.updatedAt ?? run.createdAt));
  const pipelines = [...new Set([...runs].reverse().map((run) => run.pipeline))].filter((name) => name.length > 0);
  return {
    key,
    project,
    ticket,
    ...(url ? { ticketUrl: url } : {}),
    kind: ticketKind(rules, newestFirst, workItemDirs),
    source: sourceOf(runs),
    ...(cost !== undefined ? { costUsd: cost } : {}),
    costEstimated: runs.some((run) => run.costEstimated === true),
    costUnknown: runs.some((run) => run.costUnknown === true),
    ...(activeMs !== undefined ? { activeMs } : {}),
    ...(firstAt ? { firstAt } : {}),
    ...(lastAt ? { lastAt } : {}),
    ...(outcome ? { outcome } : {}),
    pipelines,
    runs,
  };
}

/**
 * Every ticket of every listed project, plus the archived ones, costliest
 * first.
 *
 * A live run and an archived run with the same `project/ticket/runId` are the
 * same run: the live snapshot is kept, since it is the ledger itself and the
 * archive only a copy of an older one.
 */
export function readStats(options: ReadModelOptions = {}): StatsRead {
  // A missing or malformed rules file classifies nothing: every ticket is `other`.
  const config = readJson(uiFile(STATS_CONFIG_FILE, options));
  const rules = parseKindRules(config.status === "ok" ? config.value : undefined);
  const delivery = parseDelivery(config.status === "ok" ? config.value : undefined);
  const projects = readProjects(options).filter((project) => project.found);
  const store = new FileRunStateStore();
  const live = projects.flatMap((project) => liveRuns(project, store, delivery.steps));
  const archive = readArchive(options);

  const liveIds = new Set(live.map(({ project, ticket, run }) => `${project}/${ticket}/${run.runId}`));
  const archived = archive.runs.filter(({ project, ticket, run }) => !liveIds.has(`${project}/${ticket}/${run.runId}`));

  const byTicket = new Map<string, CollectedRun[]>();
  for (const entry of [...live, ...archived]) {
    const key = `${entry.project}/${entry.ticket}`;
    const list = byTicket.get(key) ?? [];
    list.push(entry);
    byTicket.set(key, list);
  }

  const projectsByName = new Map(projects.map((project) => [project.name, project]));
  const tickets = [...byTicket.entries()].map(([key, collected]) =>
    buildTicket(key, collected, rules, delivery, projectsByName),
  );
  tickets.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || a.key.localeCompare(b.key));
  return { tickets, archive: archive.state };
}
