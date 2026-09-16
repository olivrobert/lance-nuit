// runner/model/scan-record.ts
//
// Durable outcome of one `--scan` dispatch. Shapes only: writing and reading are
// `state/stores/file-scan-store.ts`, and the transitions are recorded by
// `dispatch/scan.ts`.
//
// A scan is not a run: the dispatch parent owns no run directory and no
// `events.jsonl`, so nothing else durable records a deferred ticket (beyond
// `--limit`) or one never started after an interruption. This record is the
// machine-readable answer, written at every transition rather than once at the
// end: with a single closing write, three finished tickets followed by a crash
// would read as "never started".

/** Outcome kinds a dispatch loop attributes to a ticket.
 *
 * Declared in the model layer rather than in `dispatch/` because the scan record
 * persists them: the shapes that reach disk belong here. `dispatch/` re-exports
 * it as `DispatchOutcomeKind`. */
export type DispatchOutcomeKind = "fixed" | "escalated" | "failed" | "skipped";

/** State of one ticket inside a scan.
 *
 * The four states are deliberately distinct on a record left behind by a crash:
 * `running` is the ticket that was in flight, `pending` was never started,
 * `deferred` was cut by the limit, and `done` finished. A ticket skipped on
 * resume is `done` with `startedAt === finishedAt`: it consumed no time of its
 * own. */
export type ScanTicketState =
  | { state: "pending" }
  | { state: "running"; startedAt: string }
  | {
      state: "done";
      startedAt: string;
      finishedAt: string;
      outcome: DispatchOutcomeKind;
      runId: string | null;
    }
  | { state: "deferred" };

/** Why a scan stopped before processing every discovered ticket.
 *
 * `discovery`: the tracker could not answer, so no ticket was ever known. The
 * scan ends before the loop, so such a record also has `finishedAt: null`.
 * `between-tickets`: the post-ticket hook refused to continue (a checkout that
 * would leave the next ticket on an inconsistent tree). The loop breaks but
 * still reports, so such a record carries `abort` AND a non-null `finishedAt`.
 * The two are therefore distinguished by `phase`, not by `finishedAt`. */
export interface ScanAbort {
  phase: "discovery" | "between-tickets";
  reason: string;
}

export interface ScanRecord {
  version: 1;
  pipeline: string;
  provider: string;
  project: string;
  queue: string;
  startedAt: string;
  /** `null` on a record whose scan never reached its report: the process was
   *  interrupted, or discovery aborted. A scan that found nothing to do, and one
   *  halted between tickets, both reach the report and are stamped here — only
   *  an unfinished scan is left null. */
  finishedAt: string | null;
  limit: number | null;
  /** `null` until discovery has answered. Every discovered ticket, before the
   *  limit cut the list. */
  discovered: string[] | null;
  /** One entry per discovered ticket, keyed by ticket reference. */
  tickets: Record<string, ScanTicketState>;
  abort: ScanAbort | null;
}
