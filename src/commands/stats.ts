// Cross-run statistics, read from the central `pipeline-history/runs.jsonl`.
//
// Like the other diagnostics it takes neither the lock nor the git guard, but
// unlike them it needs no work item: the history is the only input, so the whole
// project can be summarized without knowing which run to ask about.

import type { RunnerArgs } from "../model/cli-options.js";
import { log } from "../runtime/logging.js";
import { parseAge } from "../state/diagnostics.js";
import {
  type HistoryAggregate,
  type HistoryEntry,
  type HistoryFilter,
  type PipelineTotals,
  pricingTable,
  summarizeHistory,
} from "../state/stats/history-reader.js";
import { currencyOf, fmtInt, statusBadge } from "../state/stats/stats-core.js";
import type { RunnerCommand } from "./runner-command.js";
import { errorMessage } from "./shared.js";

/** Options this command reads, out of the 35 `RunnerArgs` carries. */
type StatsArgs = Pick<RunnerArgs, "ticket" | "pipelinePath" | "since" | "failures" | "includeChildren" | "limit">;

/** Runs listed individually before the aggregate, unless `--limit` says otherwise. */
const DEFAULT_RUN_ROWS = 10;

function money(amount: number, currency: string): string {
  return `${currency}${amount.toFixed(2)}`;
}

function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function statusLine(byStatus: Record<string, number>): string {
  const order = ["PASS", "FAIL", "STOPPED", "ABORTED", "UNKNOWN"];
  const known = order.filter((status) => byStatus[status]);
  const extra = Object.keys(byStatus)
    .filter((status) => !order.includes(status))
    .sort();
  return [...known, ...extra].map((status) => `${statusBadge(status)} ${byStatus[status]}`).join("  ");
}

/** Cost with its provenance attached: a total mixing exact and estimated figures,
 *  or leaving runs out entirely, must not read as an exact one. */
function costLine(
  totals: Pick<PipelineTotals, "costUsd" | "costMissing" | "costEstimated" | "costUnderCounted" | "runs">,
  currency: string,
): string {
  if (totals.costMissing === totals.runs) return "cost unavailable (no provider cost, no pricing.json)";
  const priced = totals.runs - totals.costMissing;
  // A total containing a lower bound is itself a lower bound.
  const parts = [`${totals.costUnderCounted > 0 ? "≥ " : ""}${money(totals.costUsd, currency)}`];
  if (priced > 0) parts.push(`avg ${money(totals.costUsd / priced, currency)}`);
  if (totals.costEstimated > 0) parts.push(`${totals.costEstimated} estimated from pricing.json`);
  if (totals.costUnderCounted > 0) parts.push(`${totals.costUnderCounted} under-counted (unpriced attempts)`);
  if (totals.costMissing > 0) parts.push(`${totals.costMissing} unpriced, excluded`);
  return parts.join("  ");
}

function describeFilter(filter: HistoryFilter, since?: string): string {
  const parts: string[] = [];
  if (filter.pipeline) parts.push(`pipeline ${filter.pipeline}`);
  if (filter.ticket) parts.push(`work item ${filter.ticket}`);
  if (since) parts.push(`last ${since}`);
  if (filter.failuresOnly) parts.push("failures only");
  if (filter.includeChildren) parts.push("nested runs included");
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function renderRunRows(entries: readonly HistoryEntry[], currency: string, limit: number): string[] {
  const rows: string[] = [];
  for (const entry of entries.slice(0, limit)) {
    const started = entry.startedAt ? entry.startedAt.slice(0, 16).replace("T", " ") : "?";
    const cost =
      typeof entry.costUsd === "number" ? `${entry.costUnknown ? "≥" : ""}${money(entry.costUsd, currency)}` : "-";
    const target = entry.ticket ?? "-";
    const failure = entry.status !== "PASS" && entry.failPhase ? `  fail: ${entry.failPhase}` : "";
    rows.push(
      `  ${started}  ${statusBadge(entry.status)}  ${entry.pipeline ?? "?"}  ${target}  ${cost}  ${entry.runId}${failure}`,
    );
  }
  if (entries.length > limit) rows.push(`  ... ${entries.length - limit} more (use --limit)`);
  return rows;
}

/** Human-readable summary. Kept beside the command rather than in `stats-core.ts`:
 *  that module renders one entry as markdown, this one renders a set as console
 *  text, and merging the two would give either format the other's constraints. */
export function renderStats(
  entries: readonly HistoryEntry[],
  aggregate: HistoryAggregate,
  currency: string,
  options: { filterLabel?: string; runRows?: number } = {},
): string {
  const label = options.filterLabel ?? "";
  if (aggregate.runs === 0) {
    const hint =
      aggregate.childrenSkipped > 0
        ? " Only nested runs matched; use --include-children to list them."
        : " Run a pipeline, or check that .lance-nuit/pipeline-history/runs.jsonl exists.";
    return `No run in history${label}.${hint}`;
  }

  const lines: string[] = [];
  const window =
    aggregate.firstStartedAt && aggregate.lastStartedAt
      ? ` from ${aggregate.firstStartedAt.slice(0, 10)} to ${aggregate.lastStartedAt.slice(0, 10)}`
      : "";
  lines.push(`${aggregate.runs} run(s)${label}${window}`);
  lines.push(`  ${statusLine(aggregate.byStatus)}`);
  lines.push(`  ${costLine(aggregate, currency)}`);
  const { in: input, out, cacheRead, cacheWrite } = aggregate.tokens;
  lines.push(
    `  tokens  in ${fmtInt(input)}  out ${fmtInt(out)}  cache read ${fmtInt(cacheRead)}  cache write ${fmtInt(cacheWrite)}`,
  );
  if (aggregate.childrenSkipped > 0) {
    lines.push(
      `  ${aggregate.childrenSkipped} nested run(s) excluded: their usage is already counted in the parent (--include-children to list them)`,
    );
  }

  const pipelines = Object.entries(aggregate.byPipeline).sort((a, b) => b[1].runs - a[1].runs);
  // A single pipeline would restate the totals just printed; only a breakdown of
  // several earns its own section.
  if (pipelines.length > 1) {
    lines.push("", "Per pipeline");
    for (const [name, totals] of pipelines) {
      const average =
        totals.durationSamples > 0 ? `  avg ${humanDuration(totals.durationMs / totals.durationSamples)}` : "";
      lines.push(`  ${name}  ${totals.runs} run(s)  ${statusLine(totals.byStatus)}${average}`);
      lines.push(`    ${costLine(totals, currency)}`);
    }
  } else if (pipelines[0]?.[1].durationSamples) {
    const [, totals] = pipelines[0];
    lines.push(`  avg duration ${humanDuration(totals.durationMs / totals.durationSamples)}`);
  }

  const failures = Object.entries(aggregate.byFailPhase).sort((a, b) => b[1] - a[1]);
  if (failures.length > 0) {
    lines.push("", "Failures per phase");
    for (const [phase, count] of failures) lines.push(`  ${phase}  ${count}`);
  }

  const profiles = Object.entries(aggregate.byProfile).sort((a, b) => b[1].costUsd - a[1].costUsd);
  if (profiles.length > 0) {
    lines.push("", "Per profile");
    for (const [role, totals] of profiles) {
      // Per-profile cost is only present when the projection attributed one; the
      // step count stays meaningful either way.
      const cost = totals.costUsd > 0 ? `  ${money(totals.costUsd, currency)}` : "";
      lines.push(`  ${role}  ${totals.steps} step(s)  ${fmtInt(totals.tokens.out)} out${cost}`);
    }
  }

  const rows = renderRunRows(entries, currency, options.runRows ?? DEFAULT_RUN_ROWS);
  if (rows.length > 0) lines.push("", "Runs", ...rows);

  return lines.join("\n");
}

export const statsCommand: RunnerCommand = {
  id: "stats",
  flag: "--stats",
  key: "stats",
  desc: "Summarize pipeline-history across runs: status, cost, tokens, failing phases.",
  run(args: StatsArgs): number {
    let sinceMs: number | undefined;
    if (args.since) {
      try {
        sinceMs = Date.now() - parseAge(args.since);
      } catch (error) {
        log(`--since: ${errorMessage(error)}`);
        return 1;
      }
    }

    const filter: HistoryFilter = {
      // `--pipeline` also accepts a path for a run; the history records the resolved
      // name, so filtering matches that name.
      ...(args.pipelinePath ? { pipeline: args.pipelinePath } : {}),
      ...(args.ticket ? { ticket: args.ticket } : {}),
      ...(sinceMs !== undefined ? { sinceMs } : {}),
      ...(args.failures ? { failuresOnly: true } : {}),
      ...(args.includeChildren ? { includeChildren: true } : {}),
    };

    const pricing = pricingTable();
    const { entries, aggregate } = summarizeHistory(process.cwd(), filter, pricing);
    log(
      renderStats(entries, aggregate, currencyOf(pricing), {
        filterLabel: describeFilter(filter, args.since),
        ...(args.limit ? { runRows: args.limit } : {}),
      }),
    );
    return 0;
  },
};
