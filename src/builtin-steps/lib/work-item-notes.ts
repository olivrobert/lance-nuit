// pipelines/lib/work-item-notes.ts
//
// Note builders: run facts → `WorkItemNote`.
//
// Two properties to preserve during review:
//  - No context access: everything varying is a parameter, enabling tests
//    without a runner or tracker.
//  - No formatting. We describe MEANING (one piece of information per field), and
//    the adapter owns rendering (see `modules/work-item/note.ts`).

import type { WorkItemNote } from "../../contracts/work-items.js";

const clean = (value: string | undefined): string => (value ?? "").trim();

/**
 * Delivery (merge request note).
 *
 * Empty URL = NOMINAL case, not an error: MR creation is best effort (forge
 * permissions or quota), and code is already pushed. The note states this explicitly
 * so the human knows only the MR remains to be opened.
 */
export function deliveryNote(mrUrl: string): WorkItemNote {
  const url = clean(mrUrl);
  return {
    headline: url ? `MR opened automatically: ${url}` : "Branch pushed; MR must be created manually.",
    fields: [],
  };
}
