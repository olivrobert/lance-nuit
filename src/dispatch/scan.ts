// runner/dispatch/scan.ts
//
// Scan strategy: deterministic, zero-token discovery followed by a sequential
// loop that always continues. A stopped run is escalated; a failed ticket is
// logged and the next ticket is processed.
//
// Discovery goes through `WorkItemGateway`: this strategy requests a logical queue
// and state without knowing how a tracker represents or queries them. Providers
// can therefore be replaced without changing this file.
//
// The loop itself lives in loop.ts; this file contains scan-specific behavior only.
//
// A scan is the only strategy that leaves a durable record
// (`state/stores/file-scan-store.ts`). The loop stays agnostic: it calls the
// optional `onTicketStarted` / `onTicketFinished` / `onHalted` hooks, and the
// writes happen here.

import { runSupervisedCommand } from "../exec/process-runner.js";
import { errorMessage } from "../lib/errors.js";
import { log } from "../runtime/logging.js";
import { FileScanStore } from "../state/stores/file-scan-store.js";
import { DispatchAbort } from "./abort.js";
import type { DispatchEnv, DispatchOutcome, DispatchStrategy } from "./dispatch-strategy.js";
import { attachScanRecordWriter, ScanRecordWriter, scanRecordWriterOf } from "./scan-record-writer.js";

/** Resolve the scan ticket limit. `--limit` takes precedence over the work-item
 * source; two undefined values mean unlimited. Invalid pipeline values are
 * ignored because they are configuration errors, not reasons to abort scanning.
 */
export function resolveScanLimit(cliLimit?: number, pipelineLimit?: number): number | undefined {
  for (const candidate of [cliLimit, pipelineLimit]) {
    if (candidate != null && Number.isInteger(candidate) && candidate >= 1) return candidate;
  }
  return undefined;
}

/** Open the durable record of this scan. The file store lands in the project's
 *  `pipeline-history/`, the same cross-run directory as `runs.jsonl`; tests
 *  inject their own store through `env.scanStore`. */
function beginScanRecord(env: DispatchEnv, provider: string, queue: string, limit: number | null): ScanRecordWriter {
  const store = env.scanStore ?? new FileScanStore({ projRoot: env.ctx.cwd });
  const writer = attachScanRecordWriter(
    env,
    new ScanRecordWriter(store, {
      pipeline: env.def.name,
      provider,
      project: env.ctx.config.workItem.project,
      queue,
      limit,
    }),
  );
  writer.begin();
  return writer;
}

export const scanStrategy: DispatchStrategy = {
  id: "scan",
  flag: "--scan",
  ticket: "forbidden",
  desc: "Discover tickets in the tracker and process them sequentially (continue on failure).",
  ticketError: "--scan does not accept a ticket (it discovers tickets in the tracker).",
  onFailure: "continue",

  async tickets(env: DispatchEnv): Promise<string[]> {
    const cfg = env.ctx.config;
    const source = env.def.work_item_source;
    const scan = source?.scan;
    if (!source || !scan) {
      log.error(`Scan unavailable: pipeline "${env.def.name}" declares no scannable work-item source.`);
      throw new DispatchAbort(1);
    }

    // Keep this check here rather than in the adapter: workItem.project is a
    // provider-neutral required setting and scan is the last point where the user
    // can act. A provider-specific refusal would not identify the file to edit, so
    // fail before the first network call.
    if (!cfg.workItem.project) {
      log.error("Scan unavailable: workItem.project not found (.lance-nuit/config.json or $JIRA_PREFIX in CLAUDE.md).");
      throw new DispatchAbort(1);
    }

    // The queue is declared alongside the source step that materializes tickets.
    // env.def was loaded once during boot; do not load it again here.
    const queue = source.queue;

    // Resolved before discovery: the limit is a pure function of the CLI flag and
    // the source, and the record must carry it even if the tracker never answers.
    const limit = resolveScanLimit(env.limit, scan.limit);
    const gateway = env.ctx.workItem;
    // First write, before any network call: an interrupted discovery still
    // leaves a record, with `discovered: null`.
    const writer = beginScanRecord(env, gateway.provider, queue, limit ?? null);

    let all: string[];
    try {
      // Log engine-neutral terms rather than a provider-specific query or marker;
      // the next provider may use a different dialect.
      log(`\n🔎 Scan ${gateway.provider} — project ${cfg.workItem.project}, queue ${queue}, state todo`);
      // A pipeline-owned query is the one exception: it is provider-specific by
      // design, so show it as written — it is what the author must debug.
      if (scan.query) log(`   query: ${scan.query}`);
      all = await gateway.findCandidates({ queue, state: "todo", ...(scan.query ? { query: scan.query } : {}) });
    } catch (error) {
      // An unreachable tracker is not an empty scan. Treating it as empty would
      // report success with no tickets processed.
      const reason = errorMessage(error).trim();
      writer.aborted("discovery", reason);
      log.error(`Scan aborted — ticket discovery failed: ${reason}`);
      throw new DispatchAbort(1);
    }

    // Apply the limit after discovery so the report can say how many tickets were
    // deferred; a silent query limit would look like there was nothing else to do.
    const tickets = limit == null ? all : all.slice(0, limit);
    writer.discovered(all, tickets);
    // An empty queue is a COMPLETE scan. The loop takes the `onEmpty` path and
    // never calls `report()`, so close the record here: left open, every idle
    // night would read as a scan interrupted mid-flight.
    if (tickets.length === 0) writer.finished();
    if (tickets.length > 0) log(`📋 ${tickets.length} ticket(s): ${tickets.join(", ")}`);
    if (all.length > tickets.length) {
      const dropped = all.slice(tickets.length);
      log.warn(`Limit ${limit} reached — ${dropped.length} ticket(s) deferred: ${dropped.join(", ")}`);
      log(`  Re-run the scan to process them, or use --limit <n> to expand the limit.`);
    }
    if (tickets.length > 0) log("");
    return tickets;
  },

  onEmpty() {
    return { message: "ℹ No tickets to process.", code: 0 };
  },

  /** Use an explicit --base-branch from passthrough, otherwise the config value. */
  childArgs(env: DispatchEnv): string[] {
    return env.passthrough.includes("--base-branch") ? [] : ["--base-branch", env.ctx.config.baseBranch];
  },

  banner(ticket: string): string {
    return `\n────────── Ticket ${ticket} ──────────`;
  },

  skipMessage(ticket: string): string {
    return `  ✓ ${ticket} already complete — resuming: skipped.`;
  },

  /** Return to the base branch before the next ticket. A skipped ticket ran no
   * work, so checking out again could unnecessarily fail on a dirty tree. */
  async betweenTickets(_ticket: string, env: DispatchEnv, info: { skipped: boolean }): Promise<boolean> {
    if (info.skipped) return true;
    const base = env.ctx.config.baseBranch;
    const co = await runSupervisedCommand("git", ["checkout", base], {
      cwd: env.ctx.cwd,
      timeoutMs: 120_000,
    });
    if (co.status === 0) return true;
    log.warn(
      `git checkout ${base} failed (dirty tree?) — subsequent tickets would start from an inconsistent state; stopping scan.`,
    );
    log(`${co.stdout}${co.stderr}`.trim());
    // The loop only learns that the hook refused; keep the reason for `onHalted`.
    scanRecordWriterOf(env)?.noteHaltDetail(`git checkout ${base} failed: ${`${co.stdout}${co.stderr}`.trim()}`);
    return false;
  },

  onTicketStarted(ticket: string, env: DispatchEnv): void {
    scanRecordWriterOf(env)?.ticketStarted(ticket);
  },

  onTicketFinished(outcome: DispatchOutcome, env: DispatchEnv): void {
    scanRecordWriterOf(env)?.ticketFinished(outcome.ticket, outcome.outcome, outcome.runId ?? null);
  },

  onHalted(reason: string, env: DispatchEnv): void {
    scanRecordWriterOf(env)?.haltedBetweenTickets(reason);
  },

  report(outcomes: DispatchOutcome[], tickets: string[], env: DispatchEnv): void {
    scanRecordWriterOf(env)?.finished();

    const of = (kind: DispatchOutcome["outcome"]): DispatchOutcome[] => outcomes.filter((o) => o.outcome === kind);
    const line = (label: string, list: DispatchOutcome[]): string =>
      `${label} : ${list.length}${list.length ? ` → ${list.map((o) => o.ticket).join(", ")}` : ""}`;

    log(`\n──────────── Scan ${env.def.name} complete ────────────`);
    log(`Scanned tickets: ${tickets.length}`);
    log(line("Fixed    ", of("fixed")));
    log(line("Escalated", of("escalated")));
    log(line("Failed   ", of("failed")));
  },
};
