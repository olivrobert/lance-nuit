// stats-core — single source for the run-stats schema and rendering.
//
// Shared by the runner state projection and optional statistics readers that
// consume the central history.
//
// Shape of an entry in the central pipeline-history/runs.jsonl projection:
//   { runId, pipeline, ticket, ticketDir, sessionId, startedAt, endedAt,
//     status, failPhase, phases: { <phase>: { agents, fixLoops, tokens } },
//     totals: { in, out, cacheRead, cacheWrite }, models: { <model-id>: tokens },
//     profiles: { <role>: { steps, tokens, costUsd? } },
//     lot, lotTitle, commit, fixEvents: [{ kind, phase, iter, contract, details }],
//     costUsd? }   <- written by the runner (exact CLI cost); estimated from
//                    pricing.json when absent.

import { matchingPricingKey } from "../../contracts/pricing.js";
import type { RunOutcomeState } from "../../model/persisted.js";

export interface TokenCounts {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Keep counters numeric so persisted stats stay comparable. The status distinguishes a
 * real zero from a backend interrupted before its usage event. */
export type UsageStatus = "complete" | "partial" | "unavailable";

export interface PhaseStats {
  agents: number;
  fixLoops: number;
  tokens: TokenCounts;
  provider?: string;
  profile?: string;
  costUsd?: number;
  usageStatus?: UsageStatus;
  costStatus?: UsageStatus;
  /** An attempt spent tokens no pricing table could price: `costUsd` is a lower
   *  bound, not an estimate. Distinct from `costStatus`, which a Codex run sets
   *  on every step because its cost is always computed from a rate table. */
  costUnknown?: true;
}

export interface RunStatsEntry {
  schemaVersion: 1;
  runId: string;
  pipeline: string;
  ticket: string | null;
  ticketDir: string | null;
  /** Run that nested this one, null for a root run. A child's usage is folded into
   *  its parent's step control, so a reader summing the history must keep only root
   *  runs or it counts the same spend twice. Absent on lines written before this
   *  field existed; such a line is read as a root run. */
  parentRunId?: string | null;
  /** Lot bounding this run; null for parent and non-feature pipelines. */
  lot?: string | null;
  lotTitle?: string | null;
  sessionId: string | null;
  sessionProvider?: string;
  startedAt: string | null;
  endedAt: string | null;
  status: "PASS" | "FAIL" | "STOPPED" | "ABORTED" | "UNKNOWN";
  outcome: RunOutcomeState;
  failPhase: string | null;
  failReason: string | null;
  phases: Record<string, PhaseStats>;
  totals: TokenCounts;
  usageStatus?: UsageStatus;
  costStatus?: UsageStatus;
  /** Set when any step is `costUnknown`: the run's `costUsd` under-counts the
   *  real spend and a reader must not present it as exact. */
  costUnknown?: true;
  models: Record<string, TokenCounts>;
  profiles: Record<string, { steps: number; tokens: TokenCounts; costUsd?: number }>;
  commit: string | null;
  branch: string | null;
  fixEvents: unknown[];
  sourceRunDir: string | null;
  warnings?: Array<{ phase: string; reason: string }>;
  costUsd?: number;
}

export interface PricingRate {
  in?: number;
  out?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

// `_currency` shares the table with per-model rates; readers must skip
// non-object values when iterating models.
export type PricingTable = { _currency?: string } & {
  [model: string]: PricingRate | string | undefined;
};

interface RenderFixEvent {
  kind?: string;
  phase?: string;
  iter?: number;
  contract?: string;
  details?: string;
}

/** Structural subset of RunStatsEntry needed by the markdown renderer, so
 *  external history readers can call it on partially-populated entries. */
export interface RunMarkdownEntry {
  runId?: string;
  pipeline?: string;
  ticket?: string | null;
  lot?: string | null;
  lotTitle?: string | null;
  sessionId?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  status?: string;
  failPhase?: string | null;
  failReason?: string | null;
  outcome?: { logPath?: string | null } | null;
  phases?: Record<string, { agents?: number; fixLoops?: number; tokens?: Partial<TokenCounts> }>;
  totals?: Partial<TokenCounts>;
  models?: Record<string, TokenCounts>;
  profiles?: Record<string, { steps?: number; tokens?: Partial<TokenCounts>; costUsd?: number }>;
  commit?: string | null;
  fixEvents?: readonly unknown[];
  costUsd?: number;
}

export const zeroTokens = (): TokenCounts => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });

// Add two counters already using the internal {in, out, cacheRead, cacheWrite} format.
export const addTokens = (acc: TokenCounts, t?: Partial<TokenCounts> | null): void => {
  for (const k of Object.keys(acc) as Array<keyof TokenCounts>) acc[k] += t?.[k] || 0;
};

export const fmtInt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export const statusBadge = (s?: string): string =>
  s === "PASS"
    ? "✅ PASS"
    : s === "FAIL"
      ? "❌ FAIL"
      : s === "STOPPED"
        ? "⏹ STOPPED"
        : s === "ABORTED"
          ? "🛑 ABORTED"
          : `⚪ ${s || "?"}`;

// fixEvents.details comes from an HTML-escaped workflow result.
export const unescapeHtml = (s: string): string =>
  String(s)
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

// Symbol displayed before amounts; pricing.json rates use the
// currency entered by the project ("_currency": "€" for euro pricing), default "$".
export const currencyOf = (pricing?: PricingTable | null): string =>
  (pricing && typeof pricing._currency === "string" && pricing._currency) || "$";

/**
 * A pricing table these helpers may actually use, or null.
 *
 * A non-USD table is dropped exactly as `pricingTable()` drops it at the command
 * boundary: the runner's `costUsd` is always in dollars and takes precedence over
 * any estimate, so keeping a euro table would label dollar amounts "€". Every
 * exported helper that mixes a `costUsd` with `currencyOf` funnels through here,
 * so a direct caller cannot reintroduce the mismatch.
 */
export const usablePricing = (pricing?: PricingTable | null): PricingTable | null =>
  pricing && currencyOf(pricing) === "$" ? pricing : null;

const spentTokens = (t: TokenCounts): number => (t.in || 0) + (t.out || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0);

// Same validation as `projectPricingForModel`: at least one rate, and every stated
// rate a finite number >= 0.
const isUsableRate = (rate: PricingRate): boolean => {
  const values = [rate.in, rate.out, rate.cacheRead, rate.cacheWrite];
  return (
    values.some((value) => value !== undefined) &&
    !values.some((value) => value !== undefined && (!Number.isFinite(value) || value < 0))
  );
};

// Cost of a run from its model breakdown. Prices are never hardcoded because they
// change; use the project's pricing.json, otherwise leave the cost absent (null).
//
// A model the table cannot price makes the whole run unpriceable, not cheaper: a
// silent skip returned $0.00 for a table that simply did not list the model, and
// the run then read as "priced, estimated" in every total. Keys are matched the
// way the runner matches them — exactly, then by longest name fragment.
export function costOf(models?: Record<string, TokenCounts> | null, pricing?: PricingTable | null): number | null {
  const table = usablePricing(pricing);
  if (!table) return null;
  const candidates = Object.keys(table).filter((key) => key !== "_currency" && typeof table[key] === "object");
  let usd = 0;
  let unpriced = 0;
  for (const [model, t] of Object.entries(models || {})) {
    const key = matchingPricingKey(model, candidates);
    const p = key ? table[key] : undefined;
    // A rate that is negative or not a finite number is rejected, not coerced to
    // zero: the runner refuses the same entry, and a silent 0 would price the run
    // as free instead of unpriceable.
    if (!p || typeof p === "string" || !isUsableRate(p)) {
      // A model with no tokens costs nothing whether or not it is listed.
      if (spentTokens(t) > 0) unpriced += 1;
      continue;
    }
    usd +=
      (t.in * (p.in || 0) +
        t.out * (p.out || 0) +
        t.cacheRead * (p.cacheRead || 0) +
        t.cacheWrite * (p.cacheWrite || 0)) /
      1e6;
  }
  return unpriced > 0 ? null : usd;
}

// Entry cost: costUsd written by the runner (the exact Claude CLI cost, including
// subagents) takes precedence over the token × pricing estimate.
export function entryCost(entry: RunMarkdownEntry | null | undefined, pricing?: PricingTable | null): number | null {
  if (entry && typeof entry.costUsd === "number") return entry.costUsd;
  return costOf(entry?.models, pricing);
}

// Detailed markdown summary of one run: a readable mirror of the history entry
// with the header, tokens, phase/model breakdown, and fix loops.
// opts.lotCostBudget is the per-lot run budget; overruns are shown in the header
// and feed recalibration. Callers must not pass it for a parent entry that
// aggregates several lots: the sum is not comparable with a per-lot budget.
// The budget applies to COST, not output tokens: SDK `usage.output_tokens` covers
// only the last assistant message and excludes subagents, while `total_cost_usd`
// is cumulative.
export function renderRunMarkdown(
  entry: RunMarkdownEntry,
  rawPricing?: PricingTable | null,
  opts: { lotCostBudget?: number } = {},
): string {
  // `entryCost` and the profile costs are dollar figures written by the runner, so
  // the symbol printed beside them must be the dollar too: a euro table is dropped
  // rather than allowed to relabel them.
  const pricing = usablePricing(rawPricing);
  const tokLine = (o: Partial<TokenCounts>) =>
    `${fmtInt(o.in || 0)} | ${fmtInt(o.out || 0)} | ${fmtInt(o.cacheRead || 0)} | ${fmtInt(o.cacheWrite || 0)}`;
  const dur =
    entry.startedAt && entry.endedAt
      ? `${Math.round((Date.parse(entry.endedAt) - Date.parse(entry.startedAt)) / 60000)}min`
      : "?";
  const cost = entryCost(entry, pricing);
  const out: string[] = [];
  out.push(`# Run ${entry.ticket || entry.runId} — ${statusBadge(entry.status)}`, "");
  out.push(`- **Pipeline**: ${entry.pipeline || "?"}`);
  // Detail entry: the portion of a parent run restricted to one lot.
  if (entry.lot) out.push(`- **Lot**: ${entry.lot}${entry.lotTitle ? ` — ${entry.lotTitle}` : ""}`);
  out.push(`- **Duration**: ${dur}${entry.startedAt ? ` (${entry.startedAt} → ${entry.endedAt || "?"})` : ""}`);
  if (entry.failPhase) out.push(`- **Failure phase**: ${entry.failPhase}`);
  if (entry.failReason) out.push(`- **Reason**: ${entry.failReason}`);
  if (entry.outcome?.logPath) out.push(`- **Log**: \`${entry.outcome.logPath}\``);
  if (entry.commit) out.push(`- **Commit**: \`${String(entry.commit).slice(0, 7)}\``);
  if (entry.sessionId) out.push(`- **Session**: \`${entry.sessionId}\``);
  out.push(`- **Run id**: \`${entry.runId || "?"}\``);
  if (cost != null) out.push(`- **Cost**: ≈ ${currencyOf(pricing)}${cost.toFixed(2)}`);

  const budget = opts.lotCostBudget;
  if (budget != null && budget > 0 && cost != null && cost > budget)
    out.push(
      `- **⚠️ Budget exceeded**: ${currencyOf(pricing)}${cost.toFixed(2)} > ${currencyOf(pricing)}${budget} (\`lotCostBudget\`)`,
    );

  out.push(
    "",
    "## Tokens",
    "",
    "| | in | out | cache read | cache write |",
    "|---|--:|--:|--:|--:|",
    `| **Total** | ${tokLine(entry.totals || {})} |`,
  );

  const phases = Object.entries(entry.phases || {}).sort((a, b) => (b[1].tokens?.out || 0) - (a[1].tokens?.out || 0));
  if (phases.length) {
    out.push(
      "",
      "## Phases",
      "",
      "| Phase | Agents | Fix | in | out | cache read | cache write |",
      "|---|--:|--:|--:|--:|--:|--:|",
    );
    for (const [name, p] of phases)
      out.push(`| ${name} | ${p.agents || 0} | ${p.fixLoops || 0} | ${tokLine(p.tokens || {})} |`);
  }

  const models = Object.entries(entry.models || {}).sort((a, b) => (b[1].out || 0) - (a[1].out || 0));
  if (models.length) {
    out.push("", "## Models", "", "| Model | in | out | cache read | cache write |", "|---|--:|--:|--:|--:|");
    for (const [m, u] of models) out.push(`| ${m} | ${tokLine(u)} |`);
  }

  const profiles = Object.entries(entry.profiles || {}).sort(
    (a, b) => (b[1].costUsd || 0) - (a[1].costUsd || 0) || (b[1].tokens?.out || 0) - (a[1].tokens?.out || 0),
  );
  if (profiles.length) {
    out.push(
      "",
      "## Profiles",
      "",
      "| Profile | Steps | in | out | cache read | cache write | Cost |",
      "|---|--:|--:|--:|--:|--:|--:|",
    );
    for (const [name, p] of profiles) {
      const profileCost = typeof p.costUsd === "number" ? `${currencyOf(pricing)}${p.costUsd.toFixed(2)}` : "—";
      out.push(`| ${name} | ${p.steps || 0} | ${tokLine(p.tokens || {})} | ${profileCost} |`);
    }
  }

  if (Array.isArray(entry.fixEvents) && entry.fixEvents.length) {
    out.push("", "## Fix-loops", "");
    for (const raw of entry.fixEvents) {
      const ev = raw as RenderFixEvent;
      const kind = ev.kind === "fail" ? "🔴" : ev.kind === "fix" ? "🟢" : "·";
      const first =
        unescapeHtml(String(ev.details || ""))
          .split("\n")
          .find((l) => l.trim()) || "";
      out.push(
        `- ${kind} **${ev.phase || "?"}** iter ${ev.iter ?? "?"} · \`${ev.contract || "?"}\` — ${first.slice(0, 200)}`,
      );
    }
  }
  return `${out.join("\n")}\n`;
}
