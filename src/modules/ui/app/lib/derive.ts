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
  ItemCost,
  ItemDetail,
  RequestedSheetTab,
  RunRecap,
  RunRecapStep,
  RunReport,
  RunStepsView,
  SheetTab,
  TreeFile,
  TreeNode,
  VerbAction,
  WorkItemTree,
} from "../api/types.js";
import { fmtAge } from "./format.js";
import { linkableUrl } from "./url.js";

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

/** A finished run that delivered: `PASS`, in the `done` group, neither closed
 *  by hand nor relaunched. The one case the header calls "Delivered". */
export function isDelivered(item: Item): boolean {
  return item.group === "done" && item.status === "PASS" && !item.closed && item.launch?.alive !== true;
}

/** What a delivered run offers ahead of the verbs: its report's primary link
 *  (the merge request) and a copy button for the value the report marks as
 *  copyable (the branch). */
export interface DeliveryActions {
  link?: { label: string; url: string };
  copy?: { label: string; value: string };
}

/**
 * The delivery actions of an item, or `null` when it has none — then the
 * action row is exactly `verbsFor`.
 *
 * Only a delivered run (`isDelivered`) with a report has them. The link must be
 * one this dashboard links to (`linkableUrl`), even though the read model
 * already filters: an `href` is checked where it is made. The first `delivered`
 * entry with `copy` is the copy button, labelled after its entry ("Copy
 * branch").
 */
export function deliveryActions(item: Item, report: RunReport | null | undefined): DeliveryActions | null {
  if (!report || !isDelivered(item)) return null;
  const primary = report.links?.find((link) => link.primary);
  const url = linkableUrl(primary?.url);
  const copyable = report.delivered?.find((entry) => entry.copy && entry.value);
  const actions: DeliveryActions = {
    ...(primary && url ? { link: { label: primary.label, url } } : {}),
    ...(copyable ? { copy: { label: `Copy ${copyable.label.toLowerCase()}`, value: copyable.value } } : {}),
  };
  return actions.link || actions.copy ? actions : null;
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

/** The tab an item opens on when the reader has expressed no preference. A
 *  finished run opens on its report when it wrote one for this run. */
export function defaultSheetTab(item: Item, detail?: Pick<ItemDetail, "report"> | null): SheetTab {
  if (item.group === "failure") return "diagnostic";
  if (item.group === "done" && detail?.report) return "report";
  if (item.group === "running" || item.group === "done") return "run";
  return "document";
}

/**
 * The tab actually shown.
 *
 * A tab whose content does not exist is never rendered empty: it falls back,
 * once, to the item's default — and `document` falls back further, to `files`
 * when there is a tree and to `diagnostic` when there is none. The chain is
 * shallow on purpose; a second-level fallback that could itself fall back would
 * be a loop waiting to happen. `run` is the one tab placed before that chain:
 * with neither a recap nor steps it reads as a request for `document`, and goes
 * no further than `document` itself would. `report` exists only with a valid
 * report of the current run; without one it is the item's default instead.
 */
export function currentSheetTab(item: Item, detail: ItemDetail | null, requested: RequestedSheetTab): SheetTab {
  const fallback = defaultSheetTab(item, detail);
  const requestedTab = requested === "auto" ? fallback : requested;
  const asked = requestedTab === "report" && !detail?.report ? fallback : requestedTab;
  const wanted = asked === "run" && !detail?.recap && !detail?.steps ? "document" : asked;
  const tree = detail?.tree;
  if (wanted === "document" && !tree?.gatePath && !tree?.defaultPath) return tree ? "files" : "diagnostic";
  if (wanted === "files" && !tree) return fallback;
  if (wanted === "diagnostic" && item.group !== "failure" && !item.launch) return fallback;
  return wanted;
}

/** What the sidebar filters on: a project chip and the search box. */
export interface ItemFilters {
  filter: string | null;
  query: string;
}

/** The rows the list shows. Both filters are cumulative, and the search
 *  matches the fields the row itself displays. */
export function visibleItems(items: readonly Item[], filters: ItemFilters): Item[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (filters.filter && item.project.name !== filters.filter) return false;
    if (!query) return true;
    return [item.ticket, item.title, item.pipeline, item.project.name, reasonOf(item)]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(query));
  });
}

// ───────────────────────── the timeline ─────────────────────────

/** Local hour a night starts at: a run belongs to the night that began at the
 *  latest such hour at or before its `updatedAt`. A constant until the boundary
 *  proves wrong in practice. */
export const NIGHT_START_HOUR = 18;

/** Stable ids, so the jump chips and the open state of a `<details>` survive a
 *  poll that reshuffles the rows. */
export type TimelineSectionId = "needs" | "running" | "night-0" | "night-1" | "week" | "earlier";

export interface TimelineSection {
  id: TimelineSectionId;
  label: string;
  /** Dates the section covers (`Thu 24 → Fri 25`), so a relative label is never
   *  the only reference. Absent on `needs` and `running`. */
  range?: string;
  items: Item[];
  /** Sum of the rows' costs, for `fmtCost`: `unknown` when any row is a floor. */
  cost: ItemCost;
  /** Closed by default: only `earlier`. */
  collapsed: boolean;
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Start of the night containing `date`, in local time. */
function nightStart(date: Date): Date {
  const start = new Date(date);
  start.setHours(NIGHT_START_HOUR, 0, 0, 0);
  if (start.getTime() > date.getTime()) start.setDate(start.getDate() - 1);
  return start;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** How many nights before `now`'s night the item's night started; `null` when
 *  its date does not parse. A date in the future counts as the current night. */
function nightIndex(item: Item, currentNight: Date): number | null {
  const at = new Date(item.updatedAt);
  if (!Number.isFinite(at.getTime())) return null;
  // Rounded: a daylight-saving change makes one night 23 or 25 hours long.
  return Math.max(0, Math.round((currentNight.getTime() - nightStart(at).getTime()) / DAY_MS));
}

function fmtDay(date: Date): string {
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function fmtClock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function byUpdatedDesc(a: Item, b: Item): number {
  const left = Date.parse(a.updatedAt);
  const right = Date.parse(b.updatedAt);
  return (Number.isFinite(right) ? right : -Infinity) - (Number.isFinite(left) ? left : -Infinity) || 0;
}

function sumCost(items: readonly Item[]): ItemCost {
  let usd: number | undefined;
  let estimated = false;
  let unknown = false;
  for (const item of items) {
    if (typeof item.cost.usd === "number") usd = (usd ?? 0) + item.cost.usd;
    estimated ||= item.cost.estimated;
    unknown ||= item.cost.unknown === true;
  }
  return { ...(usd === undefined ? {} : { usd }), estimated, ...(unknown ? { unknown: true } : {}) };
}

function section(
  id: TimelineSectionId,
  label: string,
  items: Item[],
  extra: { range?: string; collapsed?: boolean } = {},
): TimelineSection {
  return {
    id,
    label,
    ...(extra.range ? { range: extra.range } : {}),
    items,
    cost: sumCost(items),
    collapsed: extra.collapsed ?? false,
  };
}

/**
 * The list, in morning reading order: what needs you, what is running, then one
 * section per night (see the label table in the plan: the current night is
 * `Tonight` once it started today, `Last night` in the morning).
 *
 * `items` is already filtered by the project chip and the search. Empty sections
 * are omitted. Rows inside a section are newest first; `Needs you` keeps the
 * `GROUPS` order first. A date that does not parse lands in `Earlier`.
 */
export function timeline(items: readonly Item[], now: Date): TimelineSection[] {
  const currentNight = nightStart(now);
  const evening = now.getHours() >= NIGHT_START_HOUR;
  const needs: Item[] = [];
  const running: Item[] = [];
  const nights: Item[][] = [[], []];
  const week: Item[] = [];
  const earlier: Item[] = [];
  let weekOldest = 1;
  let weekNewest = 8;

  for (const item of items) {
    if (isWaiting(item)) needs.push(item);
    else if (item.group === "running") running.push(item);
    else {
      const index = nightIndex(item, currentNight);
      if (index === null || index > 7) earlier.push(item);
      else if (index <= 1) nights[index]?.push(item);
      else {
        week.push(item);
        weekOldest = Math.max(weekOldest, index);
        weekNewest = Math.min(weekNewest, index);
      }
    }
  }

  const groupRank = (item: Item): number => GROUPS.findIndex(([group]) => group === item.group);
  needs.sort((a, b) => groupRank(a) - groupRank(b) || byUpdatedDesc(a, b));
  for (const list of [running, ...nights, week, earlier]) list.sort(byUpdatedDesc);

  const nightRange = (index: number): string => {
    const start = addDays(currentNight, -index);
    return `${fmtDay(start)} → ${fmtDay(addDays(start, 1))}`;
  };
  const sections: TimelineSection[] = [];
  if (needs.length) sections.push(section("needs", "Needs you", needs));
  if (running.length) sections.push(section("running", "Running", running));
  const [current = [], previous = []] = nights;
  if (current.length) {
    sections.push(section("night-0", evening ? "Tonight" : "Last night", current, { range: nightRange(0) }));
  }
  if (previous.length) {
    sections.push(section("night-1", evening ? "Last night" : "Yesterday", previous, { range: nightRange(1) }));
  }
  if (week.length) {
    const from = addDays(currentNight, -weekOldest);
    const to = addDays(currentNight, 1 - weekNewest);
    sections.push(section("week", "This week", week, { range: `${fmtDay(from)} → ${fmtDay(to)}` }));
  }
  if (earlier.length) {
    const range = `before ${fmtDay(addDays(currentNight, -7))}`;
    sections.push(section("earlier", "Earlier", earlier, { range, collapsed: true }));
  }
  return sections;
}

/** A row carries a tag only for an exception: a plain PASS is what the night
 *  sections are made of, and saying it on every row was noise. The sheet header
 *  keeps the full status. */
export function rowShowsTag(item: Item): boolean {
  return item.launch?.alive === true || item.closed !== undefined || item.status !== "PASS";
}

/** The time a row shows. `Needs you` and `Running` keep the age, which is what
 *  matters there; a night shows the clock, `This week` the weekday too, and
 *  `Earlier` the date. */
export function rowTime(item: Item, sectionId: TimelineSectionId, now: Date): string {
  if (sectionId === "needs" || sectionId === "running") return fmtAge(item.updatedAt, now.getTime());
  const at = new Date(item.updatedAt);
  if (!Number.isFinite(at.getTime())) return "—";
  if (sectionId === "week") return `${WEEKDAYS[at.getDay()]} ${fmtClock(at)}`;
  if (sectionId === "earlier") return `${at.getDate()} ${MONTHS[at.getMonth()]}`;
  return fmtClock(at);
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

/** Under this, a step is plumbing — a gate, a guard, a copy — and giving it a
 *  lane of its own would bury the steps that actually took the time. */
export const NOTABLE_MS = 1000;

export function isNotable(step: RunRecapStep): boolean {
  if (step.status === "failed" || step.status === "aborted") return true;
  if (typeof step.costUsd === "number" && step.costUsd > 0) return true;
  return (step.durationMs ?? 0) >= NOTABLE_MS;
}

/** Narrowest bar drawn, in % of the run span: a 30-second step of a 9-hour run
 *  still has to be seen. */
const MIN_BAR_PCT = 0.4;

/** A horizontal position over the run span, in %. */
export interface RunTimelineBar {
  left: number;
  width: number;
}

export interface RunTimelineLane {
  step: RunRecapStep;
  /** Wall-clock extent of the step. Absent without a start, an end (a step
   *  still running ends at the span's end), or a span to place it on. */
  bar?: RunTimelineBar;
  wallMs?: number;
  /** The step ran an agent — its own model, a composed split, or a price. */
  agent: boolean;
}

/** Where the time of a run went, laid out for the Run tab. Every position is
 *  a percentage of the run span, so nothing here knows about pixels. */
export interface RunTimeline {
  /** Run span start, epoch ms; absent when the run has no usable span. */
  startMs?: number;
  /** 0 when the run has no usable span: nothing is placed, nothing divides. */
  spanMs: number;
  /** One lane per notable step, plus any step still running, in run order. */
  lanes: RunTimelineLane[];
  /** The other steps that ran, drawn as ticks on a single lane. */
  short: { count: number; ticks: number[] };
  skipped: string[];
  totals: { wallMs?: number };
}

function epoch(iso: string | undefined): number | undefined {
  const value = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function ranAgent(step: RunRecapStep): boolean {
  return Boolean(step.model) || (step.models?.length ?? 0) > 0 || (step.costUsd ?? 0) > 0;
}

/**
 * The Run tab's timeline, from the recap (steps, cost) and the step view
 * (when each step started and finished).
 *
 * The span is the recap's first-to-last write; when the snapshot does not carry
 * it, the earliest start and latest finish of the steps stand in. A step's bar
 * is its wall time.
 */
export function timelineLanes(steps: RunStepsView | null, recap: RunRecap): RunTimeline {
  const times = new Map((steps?.steps ?? []).map((step) => [step.id, step]));
  const starts = [...times.values()].map((step) => epoch(step.startedAt)).filter((t) => t !== undefined);
  const ends = [...times.values()].map((step) => epoch(step.finishedAt)).filter((t) => t !== undefined);
  const start = epoch(recap.startedAt) ?? (starts.length ? Math.min(...starts) : undefined);
  const end = epoch(recap.endedAt) ?? (ends.length ? Math.max(...ends) : undefined);
  const spanMs = start !== undefined && end !== undefined && end > start ? end - start : 0;
  const pct = (at: number): number => (start !== undefined && spanMs > 0 ? clampPct(((at - start) / spanMs) * 100) : 0);

  const lanes: RunTimelineLane[] = [];
  const ticks: number[] = [];
  const skipped: string[] = [];
  let shortCount = 0;

  for (const step of recap.steps) {
    if (step.status === "skipped") {
      skipped.push(step.id);
      continue;
    }
    const view = times.get(step.id);
    const from = epoch(view?.startedAt);
    const to = epoch(view?.finishedAt) ?? (step.status === "running" && spanMs > 0 ? end : undefined);

    if (!isNotable(step) && step.status !== "running") {
      shortCount += 1;
      if (from !== undefined && spanMs > 0) ticks.push(pct(from));
      continue;
    }

    const lane: RunTimelineLane = { step, agent: ranAgent(step) };
    if (from !== undefined && to !== undefined && to >= from) lane.wallMs = to - from;
    if (from !== undefined && to !== undefined && to >= from && spanMs > 0) {
      const width = Math.max(pct(to) - pct(from), MIN_BAR_PCT);
      lane.bar = { left: Math.min(pct(from), 100 - width), width };
    }
    lanes.push(lane);
  }

  return {
    ...(start !== undefined && spanMs > 0 ? { startMs: start } : {}),
    spanMs,
    lanes,
    short: { count: shortCount, ticks },
    skipped,
    totals: spanMs > 0 ? { wallMs: spanMs } : {},
  };
}

/** Label of spend no step recorded a model for. */
const UNKNOWN_MODEL = "unknown";

/**
 * What each model cost over the run, costliest first: a step's own model, and
 * the split the read model computed for a node composing pipelines. A model
 * that no step priced keeps an absent `costUsd` rather than a claimed zero.
 */
export function costByModel(recap: RunRecap): { model: string; costUsd?: number }[] {
  const costs = new Map<string, number | undefined>();
  const add = (model: string, cost: number | undefined): void => {
    const previous = costs.get(model);
    costs.set(model, typeof cost === "number" ? (previous ?? 0) + cost : previous);
  };
  for (const step of recap.steps) {
    if (step.models?.length) for (const split of step.models) add(split.model, split.costUsd);
    else if (step.model) add(step.model, step.costUsd);
    else if ((step.costUsd ?? 0) > 0) add(UNKNOWN_MODEL, step.costUsd);
  }
  return [...costs]
    .map(([model, costUsd]) => ({ model, ...(costUsd !== undefined ? { costUsd } : {}) }))
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
}

/**
 * Items that started waiting for the reader since the previous poll.
 *
 * `previous` is the set of waiting keys the last poll saw, or `null` before the
 * first one: what was already waiting when the page opened is on screen, and
 * announcing it again would be noise. A run that leaves `Needs you` and comes back
 * — a rerun that stopped again — is announced again, because it is a new stop.
 */
export function newlyWaiting(previous: ReadonlySet<string> | null, items: readonly Item[]): Item[] {
  if (previous === null) return [];
  return items.filter((item) => isWaiting(item) && !previous.has(item.key));
}

/** Keys of the items waiting for the reader, for the next `newlyWaiting`. */
export function waitingKeys(items: readonly Item[]): Set<string> {
  return new Set(items.filter(isWaiting).map((item) => item.key));
}

/** How the banner qualifies what is on screen: `ok`, `stale` when no read
 *  landed for a while without any failing, `lost` when the last one failed. */
export type Freshness = "ok" | "stale" | "lost";

/** Past this age, a screen whose reads stopped landing is called stale. It is
 *  above the hidden-tab interval, so a tab coming back to the foreground is not
 *  flagged in the instant before its first read answers. */
export const STALE_AFTER_MS = 90_000;

export function freshnessOf(refreshedAt: number | null, refreshError: string | null, now: number): Freshness {
  if (refreshError !== null) return "lost";
  if (refreshedAt !== null && now - refreshedAt > STALE_AFTER_MS) return "stale";
  return "ok";
}

/** "Updated just now", "Updated 4m ago" — the age of what is on screen. */
export function updatedLabel(refreshedAt: number | null, now: number): string {
  if (refreshedAt === null) return "Not updated yet";
  if (now - refreshedAt < 60_000) return "Updated just now";
  return `Updated ${fmtAge(new Date(refreshedAt).toISOString(), now)}`;
}

/** One line of the report's "Left for you": a follow-up the run listed, or a
 *  criterion's reserve, which names the criterion it belongs to. */
export interface LeftForYouEntry {
  text: string;
  detail?: string;
  source?: string;
  criterion?: string;
}

/** Everything the report leaves to a human: its follow-ups, then the reserve of
 *  every criterion that has one, met or not. */
export function leftForYou(report: RunReport): LeftForYouEntry[] {
  const followUps = (report.followUps ?? []).map(
    (entry): LeftForYouEntry => ({
      text: entry.text,
      ...(entry.detail ? { detail: entry.detail } : {}),
      ...(entry.source ? { source: entry.source } : {}),
    }),
  );
  const reserves = (report.criteria ?? []).flatMap((criterion): LeftForYouEntry[] =>
    criterion.reserve
      ? [{ text: `Reserve on ${criterion.id}`, detail: criterion.reserve, criterion: criterion.id }]
      : [],
  );
  return [...followUps, ...reserves];
}

/** The key of a screenshot: its path relative to the work item. Two lots can
 *  write the same file name, their directories tell them apart; a criterion's
 *  `captures` list holds these paths. */
export function capturePath(dir: string, name: string): string {
  const base = dir.replace(/\/+$/, "");
  return base ? `${base}/${name}` : name;
}

/** The number of each screenshot, `01`, `02`…, in the order the report lists
 *  them, keyed by {@link capturePath}: the reader matches the number on a
 *  criterion with the one under the thumbnail. A path listed twice keeps its
 *  first number. */
export function captureNumbers(report: RunReport): Map<string, string> {
  const numbers = new Map<string, string>();
  for (const group of report.captures ?? []) {
    for (const file of group.files) {
      const path = capturePath(group.dir, file.name);
      if (!numbers.has(path)) numbers.set(path, String(numbers.size + 1).padStart(2, "0"));
    }
  }
  return numbers;
}

/** The review list as plain text, for a reader to paste into a message. */
export function reviewText(review: NonNullable<RunReport["forReview"]>): string {
  const lines = review.items.map((entry) => `- ${entry.ref ? `${entry.ref}: ` : ""}${entry.text}`);
  return [review.title, "", ...lines].join("\n");
}
