import { appendFileSync } from "node:fs";
import type { JsonRecord } from "../../lib/json-values.js";

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

/** Kill reason shared by every backend's budget guard. `source` says whether the
 *  amount was estimated from a price table or reported by the provider. */
export function budgetExceededReason(
  amountUsd: number,
  remainingUsd: number,
  source: "estimated" | "reported",
): string {
  return `budget exceeded ($${amountUsd.toFixed(2)} ${source} > $${remainingUsd.toFixed(2)} remaining)`;
}

/**
 * Kill reason of the accounting guard, shared by every backend that can prove a
 * live attempt unpriceable. The prefix is the contract `killFields` reads, so it
 * must stay distinct from `budget exceeded`: the two stops send an operator to
 * two different flags.
 *
 * `detail` names what could not be priced (the model, or the reported zero), so
 * the step log says why rather than only that.
 */
export function costUnaccountedReason(detail: string): string {
  return `cost unaccounted (${detail}) — rerun with --allow-unmetered to authorize it`;
}
