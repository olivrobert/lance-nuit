// runner/step/escalation.ts
//
// Two-rung escalation ladder: effort first, model second.
//
// Increasing effort adds thinking on the same price tier; changing tier adds the
// price multiplier. More thinking is therefore the cheaper first response to an
// ordinary retry threshold.
//
// A wall-clock timeout remains a fast-path reason that effort cannot fix. The latch
// is sticky and never moves down the ladder.

import type { AgentEscalation, EffortLevel } from "../contracts/backends.js";
import type { StepFailure } from "../model/definition.js";

/** Retries tolerated before the ladder moves, when the step declares none.
 *
 *  Shared by the rerun loop and the fix loop: the same `escalate_after` must denote
 *  the same attempt number in both, and two literals would drift apart in silence. */
export const DEFAULT_ESCALATE_AFTER = 2;

/** Current ladder rung. `none` means the step's nominal settings. */
export type EscalationRung = "none" | "effort" | "model";

const RUNG_ORDER: Record<EscalationRung, number> = { none: 0, effort: 1, model: 2 };
export interface EscalationLadder {
  escalateModel?: string;
  escalateEffort?: EffortLevel;
}

/** Build the common ladder description used by rerun and repair strategies. */
export function escalationLadderFor(
  failure: Pick<StepFailure, "escalate_model" | "escalate_effort">,
): EscalationLadder {
  return {
    ...(failure.escalate_model ? { escalateModel: failure.escalate_model } : {}),
    ...(failure.escalate_effort ? { escalateEffort: failure.escalate_effort } : {}),
  };
}

/**
 * Rung to apply to the next attempt, starting from the rung already reached.
 *
 * `retries` is the number of attempts already made, evaluated before increment.
 */
export function escalationRung(args: {
  timedOut: boolean;
  retries: number;
  escalateAfter: number;
  current: EscalationRung;
  ladder: EscalationLadder;
}): EscalationRung {
  const { escalateModel, escalateEffort } = args.ladder;
  const highest = (candidate: EscalationRung): EscalationRung =>
    RUNG_ORDER[candidate] > RUNG_ORDER[args.current] ? candidate : args.current;

  // Higher effort cannot make a timeout useful.
  if (args.timedOut) {
    return escalateModel ? highest("model") : args.current;
  }
  if (args.retries < args.escalateAfter) return args.current;
  if (args.current === "none" && escalateEffort) return "effort";
  return escalateModel ? highest("model") : args.current;
}

/**
 * Rung for the next attempt, plus whether it moved, so a caller logs transitions
 * only. Both retry loops call this at the same point — before incrementing their
 * counter, since `retries` counts attempts already made — and the shared call is
 * what keeps that invariant true, rather than a comment on each side.
 */
export function advanceRung(args: {
  timedOut: boolean;
  retries: number;
  escalateAfter: number;
  current: EscalationRung;
  ladder: EscalationLadder;
}): { rung: EscalationRung; changed: boolean } {
  const rung = escalationRung(args);
  return { rung, changed: rung !== args.current };
}

/** Escalation payload handed to a backend's `applyEscalation`. */
export function escalationAxes(rung: EscalationRung, ladder: EscalationLadder): AgentEscalation {
  return { rung, model: ladder.escalateModel, effort: ladder.escalateEffort };
}

/** Rung label for run logs. */
export function escalationLabel(rung: EscalationRung, ladder: EscalationLadder): string {
  if (rung === "effort") return `effort ${ladder.escalateEffort}`;
  if (rung === "model") return `${ladder.escalateModel}`;
  return "";
}

/**
 * Sticky per-loop escalation state, shared by the rerun and fix retry loops.
 * Call `advance` before incrementing the loop counter — `retries` counts
 * attempts already made — so both loops escalate at the same attempt number.
 * Logging stays with the caller: the two loops describe transitions differently.
 */
export class EscalationLatch {
  private current: EscalationRung = "none";

  private readonly escalateAfter: number;

  constructor(
    private readonly ladder: EscalationLadder,
    escalateAfter: number | undefined,
  ) {
    this.escalateAfter = escalateAfter ?? DEFAULT_ESCALATE_AFTER;
  }

  get rung(): EscalationRung {
    return this.current;
  }

  /** Rung label for run logs; empty at the nominal rung. */
  label(): string {
    return escalationLabel(this.current, this.ladder);
  }

  /** Escalation payload for the backend's `applyEscalation`. */
  axes(): AgentEscalation {
    return escalationAxes(this.current, this.ladder);
  }

  /** Move the latch if warranted; true when the rung changed. */
  advance(args: { timedOut: boolean; retries: number }): boolean {
    const next = advanceRung({
      ...args,
      escalateAfter: this.escalateAfter,
      current: this.current,
      ladder: this.ladder,
    });
    if (next.changed) this.current = next.rung;
    return next.changed;
  }
}
