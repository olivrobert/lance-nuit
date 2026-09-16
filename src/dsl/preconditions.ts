import type { RunStopState } from "../model/persisted.js";
import type { InputPredicateResult } from "./input.js";

/** Reject an admission predicate with a reason suitable for logs.
 *
 * `stop` is the structured cause a stop gate wants persisted alongside that
 * reason (approval subject, expected recovery, undecorated detail). It is
 * ignored by admissions whose action is `skip` or `fail`. */
export function reject(reason: string, stop?: RunStopState): InputPredicateResult {
  return { ok: false, reason, ...(stop ? { stop } : {}) };
}
