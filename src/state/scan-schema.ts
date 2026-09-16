// state/scan-schema.ts
//
// Runtime schema of a persisted scan record (`pipeline-history/scans/*.json`).
//
// Same contract as `state/schema.ts`: `model/scan-record.ts` keeps the
// authoritative types, this module proves at compile time that the schema and
// those types describe the same data, and readers treat a record that fails the
// schema as absent rather than as an error to raise. `looseObject` everywhere so
// a field added by a later release does not make a record unreadable.

import * as z from "zod";
import type { AssertAssignable, Plain } from "../lib/type-assertions.js";
import type { DispatchOutcomeKind, ScanAbort, ScanRecord, ScanTicketState } from "../model/scan-record.js";

const OUTCOME_KINDS = ["fixed", "escalated", "failed", "skipped"] as const satisfies readonly DispatchOutcomeKind[];
const ABORT_PHASES = ["discovery", "between-tickets"] as const satisfies readonly ScanAbort["phase"][];

const ScanAbortSchema = z.looseObject({
  phase: z.enum(ABORT_PHASES),
  reason: z.string(),
});

/** Discriminated on `state`: an unknown state is rejected rather than silently
 *  read as one of the four, because the whole point of the record is to keep
 *  `pending`, `running`, `deferred`, and `done` apart. */
const ScanTicketStateSchema = z.discriminatedUnion("state", [
  z.looseObject({ state: z.literal("pending") }),
  z.looseObject({ state: z.literal("running"), startedAt: z.string() }),
  z.looseObject({
    state: z.literal("done"),
    startedAt: z.string(),
    finishedAt: z.string(),
    outcome: z.enum(OUTCOME_KINDS),
    runId: z.string().nullable(),
  }),
  z.looseObject({ state: z.literal("deferred") }),
]);

export const ScanRecordSchema = z.looseObject({
  version: z.literal(1),
  pipeline: z.string(),
  provider: z.string(),
  project: z.string(),
  queue: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  limit: z.number().int().nullable(),
  discovered: z.array(z.string()).nullable(),
  tickets: z.record(z.string(), ScanTicketStateSchema),
  abort: ScanAbortSchema.nullable(),
});

/** The record, or null when the value is not one. There is deliberately no
 *  `diagnose…` twin yet: unlike a run snapshot, no reader displays the reason a
 *  scan record was rejected, and `readAll` only counts it. */
export function parseScanRecord(value: unknown): ScanRecord | null {
  const result = ScanRecordSchema.safeParse(value);
  return result.success ? result.data : null;
}

/* ------------------------------------------------------------------------- *
 * Compile-time proof that the schema and the interfaces describe the same data
 * (see `lib/type-assertions.ts`).
 * ------------------------------------------------------------------------- */

type _RecordOutput = AssertAssignable<z.output<typeof ScanRecordSchema>, ScanRecord>;
type _RecordInput = AssertAssignable<Plain<ScanRecord>, z.input<typeof ScanRecordSchema>>;
type _TicketOutput = AssertAssignable<z.output<typeof ScanTicketStateSchema>, ScanTicketState>;
type _TicketInput = AssertAssignable<Plain<ScanTicketState>, z.input<typeof ScanTicketStateSchema>>;
type _AbortOutput = AssertAssignable<z.output<typeof ScanAbortSchema>, ScanAbort>;
