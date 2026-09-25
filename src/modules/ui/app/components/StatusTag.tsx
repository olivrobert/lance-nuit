// The status pill, shared by the row, the sheet header and the meta panel.
//
// A live launch overrides whatever the disk still says: the process the
// dashboard spawned is running, even though `state.json` may not have been
// written yet (spec 5.2). It uses the global `.tag` primitive from
// `styles/tokens.css`, whose per-status colours are keyed on the exact strings
// the read model sends — not a CSS Module, so every consumer shares one class.

import type { JSX } from "react";
import type { Item } from "../api/types.js";

export function StatusTag({ item }: { item: Item }): JSX.Element {
  if (item.launch?.alive) return <span className="tag RUNNING">RUNNING</span>;
  // The status stays in the sheet's details; the pill says why nobody waits on it.
  if (item.closed) return <span className="tag CLOSED">CLOSED</span>;
  return <span className={`tag ${item.status}`}>{item.status}</span>;
}
