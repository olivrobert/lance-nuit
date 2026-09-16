// runner/dispatch/scan-record-writer.ts
//
// Accumulates the durable scan record and publishes it at every transition.
//
// The record lives here rather than on `scanStrategy` because a strategy is a
// module-level singleton with no per-scan state: the writer is attached to the
// `DispatchEnv` of the scan that created it, which is the object the loop
// already threads through every hook.
//
// Publishing is best effort. A scan record is telemetry: a full disk must not
// turn a working scan into a failed one, so a write failure is reported once and
// the scan continues.

import type { DispatchOutcomeKind, ScanAbort, ScanRecord, ScanTicketState } from "../model/scan-record.js";
import type { ScanStore } from "../model/storage-ports.js";
import { log } from "../runtime/logging.js";
import type { DispatchEnv } from "./dispatch-strategy.js";

/** What a scan knows about itself before discovery answers. */
export interface ScanRecordSeed {
  pipeline: string;
  provider: string;
  project: string;
  queue: string;
  limit: number | null;
}

export class ScanRecordWriter {
  private readonly record: ScanRecord;

  private warned = false;

  private haltDetail: string | null = null;

  constructor(
    private readonly store: ScanStore,
    seed: ScanRecordSeed,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.record = {
      version: 1,
      pipeline: seed.pipeline,
      provider: seed.provider,
      project: seed.project,
      queue: seed.queue,
      startedAt: this.now(),
      finishedAt: null,
      limit: seed.limit,
      discovered: null,
      tickets: {},
      abort: null,
    };
  }

  /** First write, before any network call: a scan that dies during discovery
   *  still leaves the fact that it started, with `discovered: null`. */
  begin(): void {
    this.publish();
  }

  /** Discovery answered. `selected` is what the limit kept; every other
   *  discovered ticket is `deferred`, which is the only durable trace that the
   *  scan knowingly left work behind. */
  discovered(all: readonly string[], selected: readonly string[]): void {
    const kept = new Set(selected);
    this.record.discovered = [...all];
    this.record.tickets = Object.fromEntries(
      all.map((ticket): [string, ScanTicketState] => [
        ticket,
        kept.has(ticket) ? { state: "pending" } : { state: "deferred" },
      ]),
    );
    this.publish();
  }

  /** Discovery could not answer, or the between-ticket hook refused to continue.
   *
   *  The two do not leave the same record: a `discovery` abort ends the scan
   *  before the loop, so `finishedAt` stays null, while a `between-tickets`
   *  abort only breaks the loop and `report()` still runs, so that record
   *  carries the abort AND a non-null `finishedAt`. */
  aborted(phase: ScanAbort["phase"], reason: string): void {
    this.record.abort = { phase, reason };
    this.publish();
  }

  /** Keep the reason the strategy decided to stop, until the loop's `onHalted`
   *  turns it into the abort. The loop only knows that a hook refused. */
  noteHaltDetail(reason: string): void {
    this.haltDetail = reason;
  }

  /** The between-ticket hook refused to continue. */
  haltedBetweenTickets(loopReason: string): void {
    this.aborted("between-tickets", this.haltDetail ?? loopReason);
  }

  ticketStarted(ticket: string): void {
    this.record.tickets[ticket] = { state: "running", startedAt: this.now() };
    this.publish();
  }

  /** A ticket that was never `running` — skipped on resume — is closed with
   *  `startedAt === finishedAt`: it consumed no time of its own, and that
   *  equality is how a reader tells it apart from a ticket that really ran. */
  ticketFinished(ticket: string, outcome: DispatchOutcomeKind, runId: string | null): void {
    const finishedAt = this.now();
    const previous = this.record.tickets[ticket];
    const startedAt = previous?.state === "running" ? previous.startedAt : finishedAt;
    this.record.tickets[ticket] = { state: "done", startedAt, finishedAt, outcome, runId };
    this.publish();
  }

  /** The scan reached its report. */
  finished(): void {
    this.record.finishedAt = this.now();
    this.publish();
  }

  private publish(): void {
    try {
      this.store.write(this.record);
    } catch (error) {
      if (this.warned) return;
      this.warned = true;
      const reason = (error instanceof Error ? error.message : String(error)).trim();
      log(`⚠ Scan record could not be written (the scan itself is unaffected): ${reason}`);
    }
  }
}

/** One writer per scan, keyed by the environment the loop threads through every
 *  hook. A `WeakMap` rather than a field on the strategy: strategies are shared
 *  singletons, and two scans must not see each other's record. */
const writers = new WeakMap<DispatchEnv, ScanRecordWriter>();

export function attachScanRecordWriter(env: DispatchEnv, writer: ScanRecordWriter): ScanRecordWriter {
  writers.set(env, writer);
  return writer;
}

export function scanRecordWriterOf(env: DispatchEnv): ScanRecordWriter | undefined {
  return writers.get(env);
}
