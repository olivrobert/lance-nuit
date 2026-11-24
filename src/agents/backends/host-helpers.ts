import { appendFileSync } from "node:fs";
import type { LiveCostSink } from "../../contracts/backends.js";
import type { JsonRecord } from "../../shared/lib/json-values.js";
import type { ProcessKill, SupervisedStreamControl } from "../../shared/process/process-runner.js";

export function appendBestEffort(path: string, text: string): void {
  try {
    appendFileSync(path, text);
  } catch {
    /* logging never decides the verdict */
  }
}

/**
 * Streams agent messages into the step log exactly once per message identity,
 * even though the CLI may repeat a message as it streams. The caller feeds each
 * stream event exactly once (line splitting is its job); `extract` is the only
 * backend-specific part: how a message and its identity are read off an event.
 */
export function liveMessageSink<Event = JsonRecord>(
  path: string | undefined,
  extract: (event: Event) => { key: string; text: string } | undefined,
): (event: Event) => void {
  if (!path) return () => {};
  const seen = new Set<string>();
  return (event) => {
    const message = extract(event);
    if (!message || seen.has(message.key)) return;
    seen.add(message.key);
    appendBestEffort(path, message.text);
  };
}

/** Buffers a chunked stream into complete lines. A chunk rarely ends on a line
 *  boundary: the tail waits for the next chunk; flush() delivers a non-blank tail. */
export function lineSplitter(onLine: (line: string) => void): { push(text: string): void; flush(): void } {
  let pending = "";
  return {
    push(text: string): void {
      pending += text;
      let index = pending.indexOf("\n");
      while (index !== -1) {
        onLine(pending.slice(0, index));
        pending = pending.slice(index + 1);
        index = pending.indexOf("\n");
      }
    },
    flush(): void {
      if (pending.trim()) onLine(pending);
      pending = "";
    },
  };
}

/** Kill of every backend's budget guard. `source` says whether the amount was
 *  estimated from a price table or reported by the provider. */
export function budgetExceededKill(
  amountUsd: number,
  remainingUsd: number,
  source: "estimated" | "reported",
): ProcessKill {
  return { cause: "budget", detail: `$${amountUsd.toFixed(2)} ${source} > $${remainingUsd.toFixed(2)} remaining` };
}

/** Kill of the accounting guard, shared by every backend that can prove a live
 *  attempt unpriceable. `detail` names what could not be priced (the model, or
 *  the reported zero), so the step log says why rather than only that. */
export function costUnaccountedKill(detail: string): ProcessKill {
  return { cause: "cost-unaccounted", detail };
}

/** What a live attempt has spent so far, as its backend reads it off the stream. */
export interface LiveSpend {
  /** This attempt alone: the figure the budget is compared with. */
  costUsd?: number;
  /** Spend of the spawns this attempt replaces (transport retries), already
   *  deducted from the budget but published on top so an abort charges it too. */
  priorUsd?: number;
  model?: string;
  source: "estimated" | "reported";
  /** Set when the usage is proven unpriceable; names what could not be priced. */
  unaccounted?: string;
}

export interface LiveSpendLimits {
  onLiveCost?: LiveCostSink;
  budgetRemaining?: number;
  strictCostAccounting?: boolean;
}

/**
 * The stop sequence of every backend, run on each usage update: publish the
 * spend so an abort can persist it, then the accounting guard, then the budget
 * guard. An unaccounted spend is never compared with the budget: killing on it
 * would stop a run over a number nobody stands behind.
 */
export function guardLiveSpend(control: SupervisedStreamControl, spend: LiveSpend, limits: LiveSpendLimits): void {
  const prior = spend.priorUsd ?? 0;
  limits.onLiveCost?.(spend.costUsd == null && prior === 0 ? undefined : prior + (spend.costUsd ?? 0), spend.model);
  if (control.killed) return;
  if (spend.unaccounted !== undefined) {
    if (limits.strictCostAccounting === true) control.kill(costUnaccountedKill(spend.unaccounted));
    return;
  }
  if (limits.budgetRemaining == null || spend.costUsd == null || spend.costUsd <= limits.budgetRemaining) return;
  control.kill(budgetExceededKill(spend.costUsd, limits.budgetRemaining, spend.source));
}
