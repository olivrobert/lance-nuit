// Which item the sheet shows, and the race guard that goes with it.
//
// `detailToken` is incremented by every change of selection. A request captures
// it before leaving and checks it on return: an answer whose token no longer
// matches is thrown away rather than rendered over the new sheet. It is a store
// variable, not rendered state, so no repaint can make it lie.

import { visibleItems } from "../lib/inbox.js";
import type { ProjectView } from "../api/types.js";
import { isWaiting } from "../lib/items.js";
import type { UiState } from "./state.js";

export interface Selection {
  /** The token of the current selection, to capture before a request. */
  token(): number;
  /** Whether an answer obtained under `token` is still wanted. */
  isCurrent(token: number): boolean;
  /** Everything that belongs to the previously open item, cleared, and every
   *  request in flight invalidated. Kept in one place so a selection change can
   *  never forget half of it. */
  cleared(): Partial<UiState>;
  /** Keep the reader on the first visible item that wants them. */
  pickFirst(state: UiState): Partial<UiState>;
}

/** Whether the selected item is among the rows the filters leave on screen. */
export function selectionVisible(state: UiState): boolean {
  return visibleItems(state.items, { filter: state.filter, query: state.query }).some(
    (item) => item.key === state.selected,
  );
}

/** The chip, if the server lists its project. A chip on a project it does not
 *  list — a stale link, a project removed since — would show an empty inbox that
 *  reads as "nothing to review", so it falls back to every project. */
export function knownFilter(filter: string | null, projects: readonly ProjectView[]): string | null {
  return filter !== null && projects.some((project) => project.name === filter) ? filter : null;
}

export function createSelection(): Selection {
  let detailToken = 0;

  function cleared(): Partial<UiState> {
    detailToken += 1;
    return {
      sheetTab: "auto",
      detail: null,
      filePath: null,
      file: null,
      assumptions: null,
      launchLog: null,
      openDirs: [],
    };
  }

  return {
    token: () => detailToken,
    isCurrent: (token) => token === detailToken,
    cleared,
    pickFirst(state) {
      const rows = visibleItems(state.items, { filter: state.filter, query: state.query });
      const first = rows.find(isWaiting) ?? rows[0];
      return { selected: first ? first.key : null, ...cleared() };
    },
  };
}
