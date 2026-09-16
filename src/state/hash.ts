// Content hash shared by mechanisms that bind a decision or a produced artifact
// to the exact content it came from:
//   - `state/decisions.ts` - approval applies only to the approved artifact;
//   - `state/provenance.ts` - an output applies only to the inputs that produced it.
//
// One algorithm and one place to review it: duplicated hashing would drift when
// either mechanism changed.

import { createHash } from "node:crypto";

/** SHA-256 hex digest of text content. */
export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
