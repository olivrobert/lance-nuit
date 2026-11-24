//
// The dispatch port and the environment it receives, on their own: `strategy.ts`
// imports every strategy to build DISPATCH, and every strategy needs these
// types. Keeping them apart is what makes `src/execution/dispatch/` acyclic.

import type { PipelineContext } from "../../shared/language/context.js";
import type { Pipeline } from "../../definition/index.js";
import type { DispatchOutcomeKind, ScanStore } from "../../run/index.js";

// Declared in the model layer because the durable scan record persists it.
export type { DispatchOutcomeKind };

export interface DispatchOutcome {
  ticket: string;
  outcome: DispatchOutcomeKind;
  /** Run the child produced, when the loop could identify one. Absent for a
   *  ticket whose child died before writing a snapshot. */
  runId?: string;
}

/** What the loop learns about a ticket once its child has exited. Both halves
 *  come from the same snapshot read, so they travel together. */
export interface DispatchClassification {
  outcome: DispatchOutcomeKind;
  runId: string | null;
}

/** Environment frozen once by `runDispatch`. */
export interface DispatchEnv {
  pipelinePath: string;
  /** CLI args propagated to every child. */
  passthrough: string[];
  fresh: boolean;
  watch: boolean;
  watchAutoClose?: boolean;
  /** Explicit `--limit`, otherwise the strategy uses the work-item source limit. */
  limit?: number;
  ctx: PipelineContext;
  /** Pipeline definition loaded once before selection. */
  def: Pipeline;
  /** Sink for the durable scan record. Only the scan strategy writes one; it
   *  resolves the file store itself when this is absent, and tests inject an
   *  in-memory store here. The loop never touches it. */
  scanStore?: ScanStore;
}

/** What selecting a strategy reads from the command line, out of the options the
 *  runner parses. */
export interface DispatchArgs {
  scan: boolean;
  ticket?: string;
}

/** One dispatch's hooks. `Session` is the state a single dispatch carries from
 *  discovery to its end: `open` creates it, and the loop hands it to every hook,
 *  because a strategy object is shared by every dispatch of the process. */
export interface DispatchStrategy<Session = unknown> {
  id: string;
  /** CLI flag that activates it. */
  flag: string;
  /** Whether this invocation asks for it. */
  isActive(args: DispatchArgs): boolean;
  desc: string;
  /** Usage message when a positional ticket is given: the strategy discovers its
   *  tickets itself. */
  ticketError: string;
  /** Start one dispatch; throw DispatchAbort when it cannot run at all. */
  open(env: DispatchEnv): Session;
  /** Ticket set to process; throw DispatchAbort when its source is unreachable. */
  tickets(env: DispatchEnv, session: Session): string[] | Promise<string[]>;
  /** Result when `tickets()` returns []: message and exit code. */
  onEmpty(env: DispatchEnv): { message: string; code: number };
  /** Args appended to each child's passthrough. */
  childArgs(env: DispatchEnv): string[];
  /** Ticket-start banner. */
  banner(ticket: string): string;
  /** Message when a complete ticket run is skipped on resume. */
  skipMessage(ticket: string): string;
  /** Hook between tickets. It also runs after a skip so multi-ticket runs can
   * commit an already-complete child; returning false stops the loop. */
  betweenTickets?(
    ticket: string,
    env: DispatchEnv,
    info: { skipped: boolean },
    session: Session,
  ): boolean | Promise<boolean>;
  /** A ticket is about to be handed to a child. Not called for a ticket skipped
   *  on resume: nothing starts. */
  onTicketStarted?(ticket: string, env: DispatchEnv, session: Session): void | Promise<void>;
  /** A ticket is settled, skipped ones included. */
  onTicketFinished?(outcome: DispatchOutcome, env: DispatchEnv, session: Session): void | Promise<void>;
  /** The loop stopped before processing every ticket because `betweenTickets`
   *  refused to continue. `reason` is what the loop knows; a strategy that knows
   *  more uses its own. */
  onHalted?(reason: string, env: DispatchEnv, session: Session): void | Promise<void>;
  report(outcomes: DispatchOutcome[], tickets: string[], env: DispatchEnv): void;
  /** The dispatch reached its end: after `onEmpty`, or after `report`. Not called
   *  when `open` or `tickets` aborts, nor when the loop throws. */
  finish?(session: Session): void;
}
